/**
 * CLI: ask the copilot a question.
 *
 *   npm run ask -- "how many payments failed in the last hour?"
 *   npm run ask -- --provider anthropic "why was checkout slow earlier?"
 *   npm run ask -- --approve "issue a refund on order 12 for 2500 cents"
 */
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { run } from "./agent/loop.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { MockProvider } from "./providers/mock.js";
import { terminalApprover, denyAll } from "./guardrails/approval.js";
import { DB_PATH, buildDatabase, NOW_MS } from "./db/seed.js";
import type { ModelProvider } from "./providers/types.js";

interface Args {
  question: string;
  provider: "mock" | "anthropic";
  interactiveApproval: boolean;
  noRouter: boolean;
}

function parseArgs(argv: string[]): Args {
  const rest: string[] = [];
  let provider: Args["provider"] = "mock";
  let interactiveApproval = false;
  let noRouter = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--provider") provider = (argv[++i] as Args["provider"]) ?? "mock";
    else if (a === "--approve") interactiveApproval = true;
    else if (a === "--no-router") noRouter = true;
    else rest.push(a);
  }

  return { question: rest.join(" ").trim(), provider, interactiveApproval, noRouter };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.question) {
    console.error('Usage: npm run ask -- [--provider mock|anthropic] [--approve] "your question"');
    process.exitCode = 1;
    return;
  }

  if (!existsSync(DB_PATH)) {
    console.log("No database found — seeding one.");
    buildDatabase();
  }

  const provider: ModelProvider =
    args.provider === "anthropic" ? new AnthropicProvider() : new MockProvider();

  const rl = args.interactiveApproval
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null;

  try {
    const result = await run({
      question: args.question,
      dbPath: DB_PATH,
      provider,
      useRouter: !args.noRouter,
      nowIso: new Date(NOW_MS).toISOString(),
      approver: rl ? terminalApprover((q) => rl.question(q)) : denyAll,
    });

    console.log(`\n${result.answer}\n`);
    console.log(`  path         ${result.path}${result.intent ? ` (${result.intent})` : ""}`);
    console.log(`  provider     ${provider.name} / ${provider.model}`);
    if (result.toolsUsed.length > 0) {
      console.log(`  tools        ${result.toolsUsed.join(" -> ")}`);
    }
    console.log(`  tokens       ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`);
    console.log(`  cost         $${result.usage.costUsd.toFixed(6)}`);
    console.log(`  latency      ${result.latencyMs} ms`);
    const redacted = Object.entries(result.redactions);
    if (redacted.length > 0) {
      console.log(`  redacted     ${redacted.map(([k, v]) => `${v} ${k}`).join(", ")}`);
    }
    if (result.stoppedBecause !== "answered") {
      console.log(`  stopped      ${result.stoppedBecause}`);
    }
  } finally {
    rl?.close();
  }
}

main().catch((err) => {
  console.error(`\n${(err as Error).message}\n`);
  process.exitCode = 1;
});
