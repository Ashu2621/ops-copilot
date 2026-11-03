import { openWritable } from "../db/sqlite.js";
import { redact } from "../guardrails/pii.js";
import type { RunResult } from "./loop.js";
import type { ModelProvider } from "../providers/types.js";

/** One row per /ask, so "who spent what on which question" is a SQL query. */
export function recordRun(
  dbPath: string,
  meta: { subject: string; question: string; provider: ModelProvider; at: number },
  result: RunResult,
): void {
  const db = openWritable(dbPath);
  try {
    db.prepare(
      `INSERT INTO agent_runs (id, subject, question, path, provider, model, stopped_because, tools,
                               input_tokens, output_tokens, cost_usd, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      result.runId,
      meta.subject,
      redact(meta.question).text.slice(0, 1000),
      result.path,
      meta.provider.name,
      meta.provider.model,
      result.stoppedBecause,
      JSON.stringify(result.toolsUsed),
      result.usage.inputTokens,
      result.usage.outputTokens,
      result.usage.costUsd,
      result.latencyMs,
      new Date(meta.at).toISOString(),
    );
  } finally {
    db.close();
  }
}
