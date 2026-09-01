# ops-copilot

An agentic on-call assistant for an orders and payments service. Alerts arrive
over a signed webhook, get queued, and are triaged by an LLM agent that calls
real tools against a real database — behind the guardrails, the identity model
and the scored evaluation harness that decide whether something like this is
safe to point at production.

```
$ npm run ask -- "How many payments failed in the last hour?"

9 payment(s) failed in the last hour.

  path         router (failed_payments_last_hour)
  tokens       0 in / 0 out
  cost         $0.000000
  latency      3 ms
```

```
$ npm run ask -- "Delete all cancelled orders."

That operation was refused: not_a_read: Only SELECT (or WITH ... SELECT)
queries are allowed on this connection.
```

## Run it

Needs Node 22.5+ (for the built-in `node:sqlite`). No database server, no native
build step, no API key, no message broker.

```bash
npm install
npm run seed        # deterministic fixture database
npm test            # 113 tests, ~14s
npm run eval        # 10 scored end-to-end cases
npm run ask -- "which customers placed the most orders?"
```

The HTTP surface and the MCP server:

```bash
npm run serve       # webhooks + GraphQL + /ask + background worker
npm run mcp         # expose the tools over the Model Context Protocol
```

Live models instead of the scripted one:

```bash
ANTHROPIC_API_KEY=... npm run ask -- --provider anthropic "why was checkout slow?"
OPENAI_API_KEY=...    npm run eval -- --provider openai
```

## Surfaces

| | |
|---|---|
| `POST /webhooks/alerts` | HMAC-signed alert ingestion → 202, work queued |
| `POST /ask` | ask the agent — OIDC, `ops:ask` |
| `POST /graphql` | read API over alerts, jobs, audit trail — OIDC, `ops:read` |
| `GET /healthz` | liveness |
| MCP (stdio) | the same four tools, for any MCP client |
| CLI | `npm run ask` |

## The decisions worth reading

Most of this is ordinary plumbing. These are not, and each is documented at
length in the file that implements it.

### 1. Not every question should reach the model — `src/agent/router.ts`

A large share of on-call traffic is the same dozen questions. "How many payments
failed in the last hour" has exactly one right answer, computable by one query.
Sending it to a model adds cost, a second of latency, and a chance the number
comes back paraphrased wrong.

Known intents are answered directly from SQL. The eval harness reports the
**escalation rate** — the share of questions that actually needed the model —
because that is the number that says whether this layer earns its keep. If it
ever nears 100%, the file should be deleted rather than defended.

### 2. Read-only is enforced by the engine, not a denylist — `src/guardrails/sql.ts`

The obvious way to stop a model writing to your database is to reject queries
containing `INSERT`, `DROP`, `DELETE`. That tests a query's *spelling* rather
than its *effect*, and fails in both directions — rejecting
`WHERE reason = 'customer wanted an update'` while admitting mutations phrased a
way the regex did not anticipate.

So the load-bearing control is the storage engine: the query tool holds a
connection opened `readOnly: true`, and SQLite refuses the write however it was
phrased. The syntactic pre-check that remains is for ergonomics only. Both
properties are tested, including the false positive a denylist would produce.

### 3. PII is redacted on the way *in* — `src/guardrails/pii.ts`

A question as ordinary as "who placed the most orders?" would otherwise ship
real customer emails to a third-party API and into that provider's logs.
Redacting only the final answer would be theatre; the data would already have
left the building. Stable per-value tags let the model still reason about
identity without seeing the value.

### 4. State changes need identity, scope, and intent — `guardrails/approval.ts` + `http/auth.ts`

A tool declared `mutating` is never executed on the model's say-so. The call is
suspended and described to an approver in plain language. Over HTTP, approval
requires all three of: a valid OIDC token, the `ops:approve` scope, and an
explicit `allow_state_change` on that request.

The token subject is what gets written to `refunds.approved_by`. That is the
point of adding OIDC here — before it, the audit trail recorded the string
`"cli-operator"`, which is a label, not an identity. Auth is what makes the
human-in-the-loop guarantee *auditable* rather than merely present.

The gate lives in the agent loop rather than inside each tool, because a tool
that polices itself is one forgotten `if` away from not policing itself.

### 5. Webhooks are hostile input until proven otherwise — `src/http/webhooks.ts`

The endpoint is public, so three properties are enforced and each is tested:
**authenticity** (HMAC-SHA256 over `timestamp.body`, compared with
`timingSafeEqual` — `===` leaks the signature through response timing),
**freshness** (a valid signature is otherwise valid forever, so a captured
request replays indefinitely), and **idempotency** (at-least-once delivery is
the norm; the delivery id is a `PRIMARY KEY`, so a redelivery collides at the
database instead of triaging the same alert twice).

The timestamp is *inside* the signed material. Outside it, an attacker rewrites
it freely and freshness stops meaning anything.

### 6. Alerts are queued, not handled inline — `src/queue/queue.ts`

Senders retry on a slow response, so triaging an alert inside the request — an
agent run, several tool calls, a model round-trip — turns one alert into a pile
of duplicates. The handler records, enqueues, and returns 202.

What makes it a queue rather than a to-do list is `locked_until`: a worker
claims a job with a visibility timeout, so a worker that dies mid-run simply
lets the lease lapse and another picks the job up. Claims run inside
`BEGIN IMMEDIATE`, because a `SELECT` outside a write transaction is the classic
way to hand one job to two workers. Failures retry with backoff and then
dead-letter — a poison message that loops forever starves every healthy job
behind it.

### 7. One tool registry, three consumers — `src/tools/registry.ts`, `src/mcp/server.ts`

The Anthropic agent loop, the OpenAI adapter and the MCP server all read the
same `TOOLS` array. A tool added there appears on every surface, described
identically, and cannot drift between them. The guardrails come along for the
ride: an MCP client gets the read-only connection, the row cap and the redactor,
and `issue_refund` is refused there because an MCP session has no approver
attached.

MCP uses the low-level `Server` rather than `McpServer` precisely because
`registerTool` wants Zod schemas — translating would have created a second tool
definition to keep in sync, which is the drift this design exists to avoid.

### 8. A graph where the shape is known — `src/triage/graph.ts`

Alert triage is not an open question. The steps are known in advance: classify
the alert, gather the evidence that class needs, consult the runbook, decide.
What varies is which branch runs and how many rounds it takes.

That is a different shape from the agent loop, and the two are kept apart:

| | |
|---|---|
| `agent/loop.ts` | an open question — nobody knows which tools are needed or in what order, so the model decides each step. The shape is discovered at runtime. |
| `triage/graph.ts` | a known workflow — a LangGraph `StateGraph` with conditional edges, an accumulating evidence channel, and a bounded loop. |

Written as a flat function that shape becomes nested conditionals plus a
hand-maintained round counter, and testing one branch means running the whole
thing. As a graph, each node is a plain function testable on its own, the
branching is data, and the round cap lives in the routing rather than buried in
a node body a later edit could forget to increment.

The nodes call tools directly rather than asking a model what to do next — the
routing rules are known and cheap, and paying a model to rediscover them on
every alert is the mistake `agent/router.ts` exists to avoid. Mutating tools are
unreachable from the graph by construction: triage gathers and recommends, it
never acts.

### 9. The provider seam, tested by a second vendor — `src/providers/`

The seam was introduced so the eval harness could run offline. The OpenAI
provider is the test of whether it was a real abstraction or just a mock-shaped
hole: the loop, the guardrails, the router and the whole eval suite work against
it unchanged.

The honest cost is in the adapter. History is stored in Anthropic's shape,
because Anthropic came first and inventing a neutral format on day one would
have been speculative — so `toOpenAIMessages` translates on every send. With two
providers, one adapter is cheaper than a third internal format both must convert
to. At three, that trade flips.

## Evaluation

```
  accuracy         10/10  (100%)
  escalation rate  7/10  (70% reached the model)
  latency p50      2 ms
  latency p95      7 ms
  cost             $0.000000 total, $0.000000 per case
  pii redactions   4
```

Every assertion is a structural fact about the run — which path answered it,
which tools ran, which step failed with which code, how much was redacted.
Nothing asks a second model whether the answer "looks right", because that makes
the score a function of another model's mood and useless as a regression gate.

The suite runs against a **scripted provider** by default, and the limitation is
stated rather than hidden: it fixes the tool plan, so it scores the guardrails,
routing, dispatch and telemetry — everything except whether the model picks the
right tool. In exchange it needs no API key, costs nothing, is reproducible, and
runs on every pull request. Model judgement is scored with `--provider anthropic`
or `--provider openai`; the harness always prints which provider produced a
number.

The fixture is seeded from a fixed PRNG and a fixed clock anchor, so "9 payments
failed in the last hour" is a contract the tests assert on rather than a sample
that drifts.

## Layout

```
src/
  triage/graph.ts        LangGraph state machine for alert triage
  agent/router.ts        deterministic intents — answers without the model
  agent/loop.ts          tool-calling loop, approval gate, telemetry
  tools/registry.ts      tool schemas + implementations; `mutating` flag
  guardrails/sql.ts      read-only enforcement (engine-level + pre-check)
  guardrails/pii.ts      redaction, applied inbound and outbound
  guardrails/approval.ts human-in-the-loop gate
  http/auth.ts           OIDC/OAuth2 verification, scopes, approver identity
  http/webhooks.ts       HMAC, freshness, idempotent redelivery
  http/graphql.ts        read API, depth and limit ceilings, no mutations
  http/server.ts         routing; two auth schemes for two kinds of caller
  queue/queue.ts         durable queue: visibility timeout, backoff, DLQ
  queue/worker.ts        drains the queue, triages alerts
  rag/retrieve.ts        TF-IDF retrieval over the runbooks
  providers/             anthropic | openai | scripted, behind one interface
  mcp/server.ts          the same tools over MCP
evals/                   golden cases, graders, scored runner
runbooks/                the corpus retrieval searches
```

## Things deliberately not built

- **Vector embeddings for retrieval.** Three documents, a dozen sections, and
  queries that share vocabulary with the text almost word for word — the regime
  where lexical scoring is strongest. Embeddings would add a network dependency,
  an API key requirement before tests run, per-query latency, and a vector store
  to keep in sync. The retrieval interface is one function wide so it can be
  swapped when the corpus outgrows it.
- **Redis or SQS for the queue.** In production, probably right. Here they cost
  a service to run, which would mean `npm test` no longer works on a clean
  checkout, and buy nothing at this volume. SQLite already gives durability,
  atomic claim and backoff.
- **GraphQL mutations.** Every state change goes through the approval gate. A
  `mutation issueRefund` would be a second door into the one thing the whole
  design exists to make deliberate.
- **Streaming, and multi-turn memory.** Answers are two or three sentences, and
  every question is answered standalone. Both are next features, not gaps.

## Cost and latency

Every run reports tokens, USD cost and wall-clock latency; the eval harness
aggregates them across the suite and names the provider. Prices are explicit
tables in `src/providers/*.ts` rather than a live lookup, so cost reporting is
reproducible offline and a stale entry surfaces as a wrong number instead of a
silent zero. Provider and `effort` are the two knobs for trading accuracy
against cost and latency — the harness reports all three, so the trade can be
measured rather than guessed.
