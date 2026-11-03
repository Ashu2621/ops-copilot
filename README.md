# ops-copilot

On-call assistant for an orders/payments service. Alerts come in over a signed
webhook and get triaged in the background; people ask questions over HTTP, the
CLI or MCP. The agent calls real tools against a real database, and anything
that moves money waits for a second person to approve it.

**Live demo:** https://ops-copilot-26od.onrender.com. Ask for a refund as the
requester, watch your own approval get refused, then approve it as the second
person. It runs in demo mode: a scripted model, seeded data, and a built-in
token issuer instead of a real IdP (`OPS_COPILOT_DEMO=1`, see
`src/http/demo.ts`). Free tier, so the first request after 15 idle minutes
takes about a minute.

```
$ npm run ask -- "How many payments failed in the last hour?"

9 payment(s) failed in the last hour.

  path         router (failed_payments_last_hour)
  cost         $0.000000
  latency      3 ms
```

## Run it

Node 22.5+ (uses the built-in `node:sqlite`). No database server, no API key.

```bash
npm install
npm run seed        # deterministic demo database
npm test            # 138 tests
npm run eval        # 16 scored end-to-end cases
npm run ask -- "which customers placed the most orders?"
npm run serve       # HTTP API + background worker
npm run mcp         # same tools over MCP (stdio)
```

With a real model:

```bash
ANTHROPIC_API_KEY=... npm run ask -- --provider anthropic "why was checkout slow earlier?"
OPENAI_API_KEY=...    npm run eval -- --provider openai --json out/eval.json
```

Docker:

```bash
docker build -t ops-copilot .
docker run -p 8080:8080 --env-file .env ops-copilot
```

## API

| Route | Auth | |
|---|---|---|
| `POST /webhooks/alerts` | HMAC | ingest an alert, 202 + queued |
| `POST /ask` | OIDC `ops:ask` | ask the agent; 202 if it parked a state change |
| `GET /approvals` | OIDC `ops:approve` | list parked actions (`?status=pending`) |
| `POST /approvals/:id` | OIDC `ops:approve` | `{"decision": "approve" \| "reject"}` |
| `POST /graphql` | OIDC `ops:read` | read API over alerts, jobs, audit |
| `GET /healthz` | none | liveness |

## How a refund happens

1. Someone asks `/ask` to refund order 12. The model calls `issue_refund`.
2. Nothing runs. The exact call (order, amount, reason) is stored in
   `pending_actions` and `/ask` returns 202 with an approval id.
3. A different person with `ops:approve` calls `POST /approvals/:id`. The
   requester can't approve their own action, and approvals expire after 30 min.
4. The stored input runs. The model isn't asked again, so what was approved is
   what executes. The approver's token subject goes into `refunds.approved_by`.

The refund itself runs in one `BEGIN IMMEDIATE` transaction and checks that
the order is paid/shipped and that the total refunded never exceeds the order
total. It's idempotent on the approval id: if the process dies after paying but
before recording, approving again finishes the job without paying twice.

The CLI (`--approve`) asks the operator at the terminal for each action. MCP
and the triage graph can't reach mutating tools at all.

## Guardrails

- **Read-only SQL is enforced by SQLite, not a keyword filter.** Model-written
  queries run on a read-only connection in a worker thread, wrapped in
  `LIMIT 51`, with a 2 s timeout. A bad join from the model can't block the
  server. (`guardrails/sql.ts`, `guardrails/sql-sandbox.ts`)
- **PII is redacted before it reaches the provider**: tool results and the
  user's question. Known PII columns are tagged by name; free text is matched
  with patterns that deliberately skip timestamps, decimals and amounts. Tags
  are stable for the whole run, so `[EMAIL_1]` is the same customer in every
  tool result. Customer names are left visible because on-call needs them.
  (`guardrails/pii.ts`)
- **Limits per question**: step cap, cost budget, model call timeout. Every
  limit ends the run with a reason (`step_limit`, `budget`, `model_error`)
  instead of throwing.
- **Per-caller rate limit on `/ask`**, and every call is logged in `agent_runs`
  with subject, tools, tokens, cost and latency.
- **Webhooks**: HMAC over `timestamp.body` with `timingSafeEqual`, a freshness
  window, and the delivery id as a primary key so redeliveries are no-ops.
- **Known intents skip the model.** Five common questions (failed payments,
  pending orders, current p95 and so on) are answered straight from SQL. The eval reports the escalation rate so you can see whether
  that layer still pays for itself.

## Evals

```
  accuracy         16/16  (100%)
  tool choice      3/3  (100%)
  escalation rate  13/16  (81% reached the model)
```

Assertions are structural: which path answered, which tools ran, what failed
and why, how many refunds the case created. No LLM-as-judge.

The PR suite uses a scripted provider. That makes it free and deterministic
but it can't score tool choice, so `.github/workflows/live-eval.yml` runs the
same cases against Anthropic and OpenAI nightly and uploads the JSON report.

The `drill-*` cases script a model that misbehaves (follows an injected
instruction, over-refunds, repeats a refund, refunds a cancelled order) and
check that no money moves anyway. They're mock-only since a real model won't
misbehave on cue.

## Layout

```
src/
  agent/loop.ts           tool loop, approval hook, budgets
  agent/router.ts         known intents answered without the model
  approvals/store.ts      parked actions, four-eyes, expiry, crash-safe execute
  tools/registry.ts       tool schemas and implementations
  tools/context.ts        per-call handles: read-only db, sql sandbox, write db
  guardrails/             sql, sql-sandbox, pii, approval
  http/                   server, auth (OIDC), webhooks, graphql, ratelimit
  queue/                  SQLite job queue with leases, backoff, dead-letter
  triage/graph.ts         LangGraph state machine for alert triage
  rag/retrieve.ts         TF-IDF over the runbooks
  providers/              anthropic, openai, scripted mock
  mcp/server.ts           tools over MCP
evals/                    cases, graders, runner
```

## Not built yet

- **Vector retrieval.** Three runbooks with vocabulary that matches the
  questions is where TF-IDF does fine. `searchRunbooks` is one function, so it
  can be swapped when the corpus grows.
- **Redis/SQS queue and shared rate limits.** SQLite covers durability and
  atomic claims at this size. The rate limiter is per process; with several
  replicas it needs to move to Redis or the gateway.
- **Query cancellation inside SQLite.** A timed-out query is abandoned, not
  interrupted: its worker keeps one core busy until SQLite returns. Fixing that
  needs a progress handler, which `node:sqlite` doesn't expose yet.
- **Streaming and multi-turn memory.**
