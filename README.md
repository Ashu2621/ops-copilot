# ops-copilot

An agentic on-call assistant for an orders and payments service. It answers
operational questions by calling real tools against a real database — with the
guardrails and the scored evaluation harness that decide whether an agent like
this is safe to point at production.

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

  path         model
  tools        run_sql
```

## Run it

Needs Node 22.5+ (for the built-in `node:sqlite`). No database server, no native
build step, no API key.

```bash
npm install
npm run seed        # deterministic fixture database
npm test            # 35 unit tests
npm run eval        # 10 scored end-to-end cases
npm run ask -- "which customers placed the most orders?"
```

To use the real model instead of the scripted one:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run ask -- --provider anthropic "why was checkout slow earlier?"
npm run eval -- --provider anthropic
```

## The four decisions worth reading

Most of this project is ordinary plumbing. Four choices are not, and each is
documented at length in the file that implements it.

### 1. Not every question should reach the model — `src/agent/router.ts`

A large share of on-call traffic is the same dozen questions. "How many payments
failed in the last hour" has exactly one right answer, computable by one query.
Sending it to a language model adds cost, a second of latency, and a chance the
number comes back paraphrased wrong.

Known intents are matched and answered directly from SQL. The model handles what
nobody anticipated. The eval harness reports the **escalation rate** — the share
of questions that actually needed the model — because that is the number that
says whether this layer earns its keep. If it ever nears 100%, the file should be
deleted rather than defended.

### 2. The read-only guarantee is enforced by the engine, not a denylist — `src/guardrails/sql.ts`

The obvious way to stop a model writing to your database is to reject queries
containing `INSERT`, `DROP`, `DELETE`. That tests the *spelling* of a query
rather than its *effect*, and it fails in both directions — rejecting
`WHERE reason = 'customer wanted an update'` while admitting mutations spelled a
way the regex did not anticipate.

So the load-bearing control is the storage engine: the query tool holds a
connection opened `readOnly: true`, and SQLite refuses the write no matter how it
was phrased. There is a syntactic pre-check as well, but only for ergonomics —
it turns an engine error into a fast, specific message the agent can recover
from. Delete it and the system is still safe, just chattier.

Both properties are tested, including the false positive a denylist would
produce.

### 3. PII is redacted on the way *in*, not on the way out — `src/guardrails/pii.ts`

The customers table holds emails and phone numbers. A question as ordinary as
"who placed the most orders?" would otherwise ship real contact details to a
third-party API and into that provider's logs. Redacting only the final answer
would be theatre; the data would already have left the building.

Each distinct value gets a stable tag (`[EMAIL_1]`), so the model can still
reason about identity without ever seeing the value.

### 4. State changes stop for a human — `src/guardrails/approval.ts`

Read tools run freely. Any tool declared `mutating` is suspended: the call is
described to an approver in plain language and only executes on an explicit yes.
With no approver attached the default is refusal, so an unattended run cannot
move money.

The gate lives in the agent loop rather than inside each tool, because a tool
that polices itself is one forgotten `if` away from not policing itself. Here a
tool is gated by virtue of its declaration — the unsafe state is unreachable by
omission.

## Evaluation

```
  accuracy         10/10  (100%)
  escalation rate  7/10  (70% reached the model)
  latency p50      2 ms
  latency p95      7 ms
  tokens           9300 in / 1800 out
  cost             $0.000000 total, $0.000000 per case
  pii redactions   4
```

Every assertion is a structural fact about the run — which path answered it,
which tools ran, which step failed with which code, how much was redacted. None
of it asks a second model whether the answer "looks right", because that makes
the score a function of another model's mood and useless as a regression gate.

The suite runs against a **scripted provider** by default. That is a deliberate
trade with a real limitation, stated plainly: it fixes the tool plan, so it
scores the guardrails, routing, dispatch and telemetry — everything except
whether the model picks the right tool. In exchange, `npm run eval` needs no API
key, costs nothing, is byte-reproducible, and runs on every pull request. The
model's own judgement is scored with `--provider anthropic`; the harness always
prints which provider produced a number.

The fixture database is seeded from a fixed PRNG and a fixed clock anchor, so
"9 payments failed in the last hour" is a contract the tests assert on rather
than a sample that drifts.

## Layout

```
src/
  agent/router.ts        deterministic intents — answers without the model
  agent/loop.ts          tool-calling loop, approval gate, telemetry
  agent/prompt.ts        system prompt
  tools/registry.ts      tool schemas + implementations; `mutating` flag
  guardrails/sql.ts      read-only enforcement (engine-level + pre-check)
  guardrails/pii.ts      redaction applied inbound and outbound
  guardrails/approval.ts human-in-the-loop gate
  rag/retrieve.ts        TF-IDF retrieval over the runbooks
  providers/anthropic.ts live model, token + cost accounting
  providers/mock.ts      scripted model, for offline evals and CI
  db/                    schema, deterministic seed, sqlite shim
evals/                   golden cases, graders, scored runner
runbooks/                the corpus retrieval searches
```

## Things deliberately not built

- **Vector embeddings for retrieval.** Three documents, a dozen sections, and
  queries that share vocabulary with the text almost word for word — the regime
  where lexical scoring is strongest. Dense retrieval would add a network
  dependency, an API key requirement, per-query latency and a vector store to
  keep in sync, for no measurable gain at this size. The retrieval interface is
  one function wide so it can be swapped when the corpus outgrows it.
- **Streaming.** The answers are two or three sentences; streaming would add
  moving parts without changing what the user waits for.
- **Multi-turn memory.** Every question is answered standalone. Conversation
  state is the next feature, not a missing one.

## Cost and latency

Every run reports tokens, cost in USD and wall-clock latency, and the eval
harness aggregates them across the suite. Prices are a table in
`src/providers/anthropic.ts` rather than a live lookup, so cost reporting is
reproducible offline and a stale entry surfaces as a wrong number instead of a
silent zero. The `effort` option on the provider is the single cleanest knob for
trading accuracy against cost and latency — the harness reports all three, so
the trade can be measured rather than guessed.
