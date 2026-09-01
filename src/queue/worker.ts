/**
 * Background worker: drains the job queue and triages alerts with the agent.
 *
 * Deliberately single-threaded and pull-based. Each tick claims at most one job,
 * so an alert storm queues up rather than fanning out into concurrent agent runs
 * — which is what you want when every run costs money and the downstream
 * database has finite connections. Concurrency, if it is ever needed, is more
 * workers rather than more parallelism inside one.
 */
import { JobQueue, type Job } from "./queue.js";
import { run, type RunResult } from "../agent/loop.js";
import { denyAll } from "../guardrails/approval.js";
import type { ModelProvider } from "../providers/types.js";

export interface AlertJob {
  alertId: string;
  name: string;
  severity: string;
  summary: string;
}

export interface WorkerOptions {
  queue: JobQueue;
  dbPath: string;
  provider: ModelProvider;
  nowIso?: string;
  visibilityMs?: number;
}

/** Turn an alert into the question an on-call engineer would actually ask. */
export function alertToQuestion(alert: AlertJob): string {
  return `Alert "${alert.name}" fired at ${alert.severity} severity: ${alert.summary}. What is happening and what should I do?`;
}

export async function processOne(opts: WorkerOptions): Promise<{
  job: Job;
  result?: RunResult;
  outcome: "done" | "retrying" | "dead";
} | null> {
  const job = opts.queue.claim(opts.visibilityMs ?? 30_000);
  if (!job) return null;

  try {
    if (job.kind !== "triage_alert") {
      throw new Error(`Unknown job kind: ${job.kind}`);
    }

    const alert = job.payload as AlertJob;
    const result = await run({
      question: alertToQuestion(alert),
      dbPath: opts.dbPath,
      provider: opts.provider,
      nowIso: opts.nowIso,
      // An unattended worker must never approve a state change on its own.
      // This is the same default the CLI uses without --approve, stated here
      // explicitly because "nobody is watching" is exactly when it matters.
      approver: denyAll,
    });

    opts.queue.complete(job.id, {
      answer: result.answer,
      path: result.path,
      toolsUsed: result.toolsUsed,
      costUsd: result.usage.costUsd,
      latencyMs: result.latencyMs,
    });

    return { job, result, outcome: "done" };
  } catch (err) {
    const outcome = opts.queue.fail(job.id, (err as Error).message);
    return { job, outcome };
  }
}

/** Drain until the queue has nothing claimable. Returns how many ran. */
export async function drain(opts: WorkerOptions, max = 100): Promise<number> {
  let processed = 0;
  while (processed < max) {
    const handled = await processOne(opts);
    if (!handled) break;
    processed++;
  }
  return processed;
}
