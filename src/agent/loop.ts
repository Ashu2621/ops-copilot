import { createHash, randomUUID } from "node:crypto";
import { TOOLS_BY_NAME, toolSchemas, type ToolContext } from "../tools/registry.js";
import { openToolContext } from "../tools/context.js";
import { Redactor } from "../guardrails/pii.js";
import { SqlGuardError } from "../guardrails/sql.js";
import { denyAll, type Approver } from "../guardrails/approval.js";
import { route } from "./router.js";
import type { ModelProvider, ToolResultMessage } from "../providers/types.js";
import { SYSTEM_PROMPT } from "./prompt.js";

export interface RunOptions {
  question: string;
  dbPath: string;
  provider: ModelProvider;
  approver?: Approver;
  maxSteps?: number;
  /** Stop calling the model once this much has been spent on one question. */
  maxCostUsd?: number;
  /** Per model call. */
  modelTimeoutMs?: number;
  /** "Now" for time-relative questions. Defaults to the wall clock; tests pass the seed's clock. */
  nowIso?: string;
  /** false forces the model path even for a known intent (evals use this). */
  useRouter?: boolean;
  runId?: string;
}

export interface StepRecord {
  tool: string;
  ok: boolean;
  approved?: boolean;
  pendingApproval?: string;
  detail?: string;
  durationMs: number;
}

export type StopReason =
  | "answered"
  | "step_limit"
  | "budget"
  | "refusal"
  | "no_answer"
  | "awaiting_approval"
  | "model_error";

export interface RunResult {
  runId: string;
  answer: string;
  path: "router" | "model";
  intent?: string;
  steps: StepRecord[];
  toolsUsed: string[];
  pendingApprovals: Array<{ id: string; summary: string }>;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  latencyMs: number;
  redactions: Record<string, number>;
  stoppedBecause: StopReason;
}

export async function run(options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const {
    question,
    dbPath,
    provider,
    approver = denyAll,
    maxSteps = envInt("OPS_COPILOT_MAX_STEPS", 6),
    maxCostUsd = envNumber("OPS_COPILOT_MAX_COST_USD", 0.25),
    modelTimeoutMs = envInt("OPS_COPILOT_MODEL_TIMEOUT_MS", 60_000),
    nowIso = new Date().toISOString(),
    useRouter = true,
    runId = randomUUID(),
  } = options;

  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new RangeError(`maxSteps must be a positive integer, got ${maxSteps}`);
  }

  const ctx = openToolContext(dbPath, { writable: true });
  const redactor = new Redactor();
  const steps: StepRecord[] = [];
  const pending: RunResult["pendingApprovals"] = [];
  const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  const finish = (
    answer: string,
    path: RunResult["path"],
    stoppedBecause: StopReason,
    intent?: string,
  ): RunResult => ({
    runId,
    answer: redactor.text(answer),
    path,
    intent,
    steps,
    toolsUsed: steps.map((s) => s.tool),
    pendingApprovals: pending,
    usage,
    latencyMs: Date.now() - started,
    redactions: redactor.counts,
    stoppedBecause,
  });

  try {
    if (useRouter) {
      const routed = route(question, ctx.readDb, nowIso);
      if (routed.kind === "direct") return finish(routed.answer, "router", "answered", routed.intent);
    }

    // The question goes through the same redactor as the tool results, so a
    // pasted email gets the same tag it would get from the customers table.
    const history: unknown[] = [{ role: "user", content: redactor.text(question) }];
    const seen = new Set<string>();

    for (let step = 0; step < maxSteps; step++) {
      if (usage.costUsd >= maxCostUsd) {
        return finish(`Stopped: this question hit its $${maxCostUsd.toFixed(2)} budget.`, "model", "budget");
      }

      let turn;
      try {
        turn = await provider.send({
          system: SYSTEM_PROMPT,
          tools: toolSchemas(),
          history,
          signal: AbortSignal.timeout(modelTimeoutMs),
        });
      } catch (err) {
        return finish(`The model call failed: ${(err as Error).message}`, "model", "model_error");
      }

      usage.inputTokens += turn.usage.inputTokens;
      usage.outputTokens += turn.usage.outputTokens;
      usage.costUsd += provider.priceUsd(turn.usage.inputTokens, turn.usage.outputTokens);

      if (turn.stopReason === "refusal") {
        const why = turn.refusalCategory ? ` (${turn.refusalCategory})` : "";
        return finish(`The model declined to answer this request${why}.`, "model", "refusal");
      }
      if (turn.toolCalls.length === 0) {
        return finish(turn.text || "No answer produced.", "model", turn.text ? "answered" : "no_answer");
      }

      history.push({ role: "assistant", content: turn.raw });

      const results: ToolResultMessage[] = [];
      for (const call of turn.toolCalls) {
        results.push(await dispatch({ call, ctx, approver, runId, redactor, steps, pending, seen }));
      }

      history.push({
        role: "user",
        content: results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.toolUseId,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      });

      // Parked actions end the run here. The model doesn't get to keep going
      // as if the refund happened, and it doesn't get to try another route.
      if (pending.length > 0) {
        const list = pending.map((p) => `${p.summary} [approval ${p.id}]`).join("; ");
        return finish(`Waiting for approval: ${list}.`, "model", "awaiting_approval");
      }
    }

    return finish(
      "Stopped after reaching the tool-call limit without producing a final answer.",
      "model",
      "step_limit",
    );
  } finally {
    ctx.close();
  }
}

interface DispatchArgs {
  call: { id: string; name: string; input: Record<string, unknown> };
  ctx: ToolContext;
  approver: Approver;
  runId: string;
  redactor: Redactor;
  steps: StepRecord[];
  pending: RunResult["pendingApprovals"];
  seen: Set<string>;
}

async function dispatch(a: DispatchArgs): Promise<ToolResultMessage> {
  const { call, ctx, steps } = a;
  const startedAt = Date.now();
  const tool = TOOLS_BY_NAME.get(call.name);
  const fail = (detail: string, content: string, extra: Partial<StepRecord> = {}): ToolResultMessage => {
    steps.push({ tool: call.name, ok: false, detail, durationMs: Date.now() - startedAt, ...extra });
    return { toolUseId: call.id, content, isError: true };
  };

  if (!tool) return fail("unknown_tool", `No tool named ${call.name}.`);

  let auth;
  if (tool.mutating) {
    // Same tool + same input twice in one run is one action, not two.
    const fingerprint = `${tool.name}:${stableJson(call.input)}`;
    if (a.seen.has(fingerprint)) {
      return fail("duplicate_call", "This exact action was already requested in this run. Do not repeat it.");
    }
    a.seen.add(fingerprint);

    const summary = tool.summarise?.(call.input) ?? `${tool.name}(${JSON.stringify(call.input)})`;
    const decision = await a.approver({ runId: a.runId, tool: tool.name, input: call.input, summary });

    if (decision.status === "pending") {
      a.pending.push({ id: decision.approvalId, summary });
      steps.push({
        tool: call.name,
        ok: false,
        pendingApproval: decision.approvalId,
        detail: "awaiting_approval",
        durationMs: Date.now() - startedAt,
      });
      return {
        toolUseId: call.id,
        content: `Queued for human approval (id ${decision.approvalId}). It has not run. Do not retry.`,
        isError: false,
      };
    }
    if (decision.status === "denied") {
      return fail("approval_denied", `Refused: a human did not approve this action. ${decision.reason}`, {
        approved: false,
      });
    }
    auth = {
      approvedBy: decision.decidedBy,
      idempotencyKey: `run:${a.runId}:${sha256(fingerprint).slice(0, 16)}`,
    };
  }

  try {
    const output = await tool.run(call.input, ctx, auth);
    steps.push({
      tool: call.name,
      ok: true,
      ...(tool.mutating ? { approved: true } : {}),
      durationMs: Date.now() - startedAt,
    });
    return { toolUseId: call.id, content: a.redactor.json(output), isError: false };
  } catch (err) {
    // Errors go back to the model as is_error so it can fix its query.
    const message =
      err instanceof SqlGuardError ? `${err.code}: ${err.message}` : ((err as Error).message ?? "tool failed");
    return fail(message, message);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([x], [y]) => x.localeCompare(y));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new RangeError(`${name} must be a positive number, got "${raw}"`);
  return n;
}
