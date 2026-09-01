/**
 * Scored evaluation harness.
 *
 *   npm run eval                        # scripted provider, no API key, CI-safe
 *   npm run eval -- --provider anthropic # live model
 *   npm run eval -- --case rag-refund-guidance
 *
 * Exits non-zero when any case fails, so it works as a CI gate.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, type RunResult } from "../src/agent/loop.js";
import { MockProvider } from "../src/providers/mock.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { approveAll, denyAll } from "../src/guardrails/approval.js";
import { buildDatabase, NOW_MS } from "../src/db/seed.js";
import { grade, percentile, type Assertions, type Failure } from "./graders.js";
import type { ModelProvider } from "../src/providers/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Case {
  id: string;
  question: string;
  why: string;
  assert: Assertions;
  approval?: "approve" | "deny";
}

interface Outcome {
  case: Case;
  result: RunResult;
  failures: Failure[];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const providerName = argOf(argv, "--provider") ?? "mock";
  const only = argOf(argv, "--case");

  const provider: ModelProvider =
    providerName === "anthropic" ? new AnthropicProvider() : new MockProvider();

  let cases: Case[] = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8"));
  if (only) cases = cases.filter((c) => c.id === only);
  if (cases.length === 0) {
    console.error(only ? `No case with id "${only}".` : "No cases found.");
    process.exitCode = 1;
    return;
  }

  // Rebuild from the fixed seed so a mutating case (the approved refund) cannot
  // leak state into the next run and quietly change a later score.
  const dbPath = join(HERE, "..", "data", "eval.db");
  buildDatabase(dbPath);

  console.log(`\nops-copilot evals — provider: ${provider.name} (${provider.model})`);
  console.log(`${cases.length} case(s)\n`);

  const outcomes: Outcome[] = [];
  for (const c of cases) {
    const result = await run({
      question: c.question,
      dbPath,
      provider,
      nowIso: new Date(NOW_MS).toISOString(),
      approver: c.approval === "approve" ? approveAll : denyAll,
    });
    const failures = grade(result, c.assert);
    outcomes.push({ case: c, result, failures });

    const mark = failures.length === 0 ? "PASS" : "FAIL";
    console.log(`  ${mark}  ${c.id}`);
    for (const f of failures) {
      console.log(`          ${f.check}: expected ${f.expected}, got ${f.actual}`);
    }
  }

  report(outcomes, provider);

  if (outcomes.some((o) => o.failures.length > 0)) process.exitCode = 1;
}

function report(outcomes: Outcome[], provider: ModelProvider): void {
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

  const pct = (n: number, d: number) => (d === 0 ? "0" : ((100 * n) / d).toFixed(0));

  console.log(`
  ─────────────────────────────────────────────
  accuracy         ${passed}/${total}  (${pct(passed, total)}%)
  escalation rate  ${escalated}/${total}  (${pct(escalated, total)}% reached the model)
  latency p50      ${percentile(latencies, 50)} ms
  latency p95      ${percentile(latencies, 95)} ms
  tokens           ${tokensIn} in / ${tokensOut} out
  cost             $${cost.toFixed(6)} total, $${(cost / total).toFixed(6)} per case
  pii redactions   ${redactions}
  provider         ${provider.name} / ${provider.model}
  ─────────────────────────────────────────────
`);

  if (provider.name === "mock") {
    console.log(
      "  Note: the scripted provider fixes the tool plan, so this run scores the\n" +
        "  guardrails, routing and plumbing — not the model's tool choice. Run with\n" +
        "  --provider anthropic to score that.\n",
    );
  }
}

function argOf(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

main().catch((err) => {
  console.error(`\neval harness failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
