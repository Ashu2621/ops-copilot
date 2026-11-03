/**
 * Scored evaluation harness.
 *
 *   npm run eval                              scripted provider, no key, runs in CI
 *   npm run eval -- --provider anthropic      live model
 *   npm run eval -- --provider openai --json out/eval.json
 *   npm run eval -- --case rag-refund-guidance
 *
 * Exits non-zero when any case fails.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, type RunResult } from "../src/agent/loop.js";
import { createProvider } from "../src/providers/index.js";
import { approveAll, denyAll, type Approver } from "../src/guardrails/approval.js";
import { pendingApprover } from "../src/approvals/store.js";
import { DatabaseSync } from "../src/db/sqlite.js";
import { buildDatabase, NOW_MS } from "../src/db/seed.js";
import { grade, percentile, type Assertions, type Failure } from "./graders.js";
import type { ModelProvider } from "../src/providers/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Case {
  id: string;
  question: string;
  why: string;
  assert: Assertions;
  approval?: "approve" | "deny" | "pending";
  /** Refund rows this case is allowed to create. Checked against the database. */
  refundsCreated?: number;
  /** Drill cases script a misbehaving model, so they only mean something on mock. */
  mockOnly?: boolean;
}

interface Outcome {
  case: Case;
  result: RunResult;
  failures: Failure[];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const provider = createProvider(argOf(argv, "--provider"));
  const only = argOf(argv, "--case");
  const jsonOut = argOf(argv, "--json");

  let cases: Case[] = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8"));
  if (provider.name !== "mock") cases = cases.filter((c) => !c.mockOnly);
  if (only) cases = cases.filter((c) => c.id === only);
  if (cases.length === 0) {
    console.error(only ? `No case with id "${only}".` : "No cases found.");
    process.exitCode = 1;
    return;
  }

  // Fresh seed each run so a case that writes can't change a later score.
  const dbPath = join(HERE, "..", "data", "eval.db");
  buildDatabase(dbPath);

  console.log(`\nops-copilot evals, provider: ${provider.name} (${provider.model})`);
  console.log(`${cases.length} case(s)\n`);

  const outcomes: Outcome[] = [];
  for (const c of cases) {
    const before = countRefunds(dbPath);
    const result = await run({
      question: c.question,
      dbPath,
      provider,
      nowIso: new Date(NOW_MS).toISOString(),
      approver: approverFor(c, dbPath),
    });

    const failures = grade(result, c.assert);
    if (c.refundsCreated !== undefined) {
      const created = countRefunds(dbPath) - before;
      if (created !== c.refundsCreated) {
        failures.push({ check: "refundsCreated", expected: String(c.refundsCreated), actual: String(created) });
      }
    }
    outcomes.push({ case: c, result, failures });

    console.log(`  ${failures.length === 0 ? "PASS" : "FAIL"}  ${c.id}`);
    for (const f of failures) console.log(`          ${f.check}: expected ${f.expected}, got ${f.actual}`);
  }

  const summary = report(outcomes, provider);
  if (jsonOut) {
    mkdirSync(dirname(jsonOut), { recursive: true });
    writeFileSync(
      jsonOut,
      JSON.stringify(
        {
          ...summary,
          cases: outcomes.map((o) => ({
            id: o.case.id,
            pass: o.failures.length === 0,
            failures: o.failures,
            path: o.result.path,
            tools: o.result.toolsUsed,
            stopped: o.result.stoppedBecause,
            cost_usd: o.result.usage.costUsd,
            latency_ms: o.result.latencyMs,
          })),
        },
        null,
        2,
      ),
    );
  }

  if (outcomes.some((o) => o.failures.length > 0)) process.exitCode = 1;
}

function approverFor(c: Case, dbPath: string): Approver {
  switch (c.approval) {
    case "approve":
      return approveAll;
    case "pending":
      return pendingApprover(dbPath, "eval-requester", () => NOW_MS);
    default:
      return denyAll;
  }
}

function countRefunds(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM refunds").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function report(outcomes: Outcome[], provider: ModelProvider) {
  const passed = outcomes.filter((o) => o.failures.length === 0).length;
  const total = outcomes.length;
  const latencies = outcomes.map((o) => o.result.latencyMs);
  const cost = outcomes.reduce((sum, o) => sum + o.result.usage.costUsd, 0);
  const tokensIn = outcomes.reduce((sum, o) => sum + o.result.usage.inputTokens, 0);
  const tokensOut = outcomes.reduce((sum, o) => sum + o.result.usage.outputTokens, 0);
  const escalated = outcomes.filter((o) => o.result.path === "model").length;
  const redactions = outcomes.reduce(
    (sum, o) => sum + Object.values(o.result.redactions).reduce((a, b) => a + b, 0),
    0,
  );

  // Tool choice: of the cases that name the tools they expect, how many runs
  // used all of them. On mock this is fixed by the script; on a live model it's
  // the number that tells you whether the prompt and tool descriptions work.
  const withTools = outcomes.filter((o) => o.case.assert.toolsUsed?.length);
  const toolHits = withTools.filter((o) => o.case.assert.toolsUsed!.every((t) => o.result.toolsUsed.includes(t)));

  const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(0)}%`);

  console.log(`
  ---------------------------------------------
  accuracy         ${passed}/${total}  (${pct(passed, total)})
  tool choice      ${toolHits.length}/${withTools.length}  (${pct(toolHits.length, withTools.length)})
  escalation rate  ${escalated}/${total}  (${pct(escalated, total)} reached the model)
  latency p50      ${percentile(latencies, 50)} ms
  latency p95      ${percentile(latencies, 95)} ms
  tokens           ${tokensIn} in / ${tokensOut} out
  cost             $${cost.toFixed(6)} total, $${(cost / total).toFixed(6)} per case
  pii redactions   ${redactions}
  provider         ${provider.name} / ${provider.model}
  ---------------------------------------------
`);

  if (provider.name === "mock") {
    console.log(
      "  The scripted provider fixes the tool plan, so this run scores guardrails,\n" +
        "  routing and plumbing, not tool choice. Use --provider anthropic|openai for that.\n",
    );
  }

  return {
    provider: provider.name,
    model: provider.model,
    passed,
    total,
    tool_choice: { hits: toolHits.length, total: withTools.length },
    latency_p50_ms: percentile(latencies, 50),
    latency_p95_ms: percentile(latencies, 95),
    cost_usd: cost,
  };
}

function argOf(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

main().catch((err) => {
  console.error(`\neval harness failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
