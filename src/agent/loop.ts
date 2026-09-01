import { DatabaseSync, type DatabaseSyncInstance } from "../db/sqlite.js";
import { TOOLS_BY_NAME, toolSchemas, type ToolContext } from "../tools/registry.js";
import { redact, redactJson } from "../guardrails/pii.js";
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
  /** Anchor for time-relative questions; defaults to the seeded dataset's clock. */
  nowIso?: string;
  /** Set false to force the model path even for a known intent (used by evals). */
  useRouter?: boolean;
}

export interface StepRecord {
  tool: string;
  ok: boolean;
  approved?: boolean;
  detail?: string;
  durationMs: number;
}

export interface RunResult {
  answer: string;
  /** "router" when answered deterministically, "model" when the LLM was used. */
  path: "router" | "model";
  intent?: string;
  steps: StepRecord[];
  toolsUsed: string[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  latencyMs: number;
  redactions: Record<string, number>;
  stoppedBecause: "answered" | "step_limit" | "refusal" | "no_answer";
}

export async function run(options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const {
    question,
    dbPath,
    provider,
    approver = denyAll,
    maxSteps = Number(process.env.OPS_COPILOT_MAX_STEPS ?? 6),
    nowIso = new Date().toISOString(),
    useRouter = true,
  } = options;

  const readDb = new DatabaseSync(dbPath, { readOnly: true });
  let writeHandle: DatabaseSyncInstance | null = null;

  const ctx: ToolContext = {
    readDb,
    writeDb: () => {
      writeHandle ??= new DatabaseSync(dbPath);
      return writeHandle;
    },
  };

  const steps: StepRecord[] = [];
  const redactions: Record<string, number> = {};
  const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  const finish = (
    answer: string,
    path: RunResult["path"],
    stoppedBecause: RunResult["stoppedBecause"],
    intent?: string,
  ): RunResult => {
    readDb.close();
    writeHandle?.close();
    const safe = redact(answer);
    mergeCounts(redactions, safe.counts);
    return {
      answer: safe.text,
      path,
      intent,
      steps,
      toolsUsed: steps.map((s) => s.tool),
      usage,
      latencyMs: Date.now() - started,
      redactions,
      stoppedBecause,
    };
  };

  // ── 1. Deterministic path ────────────────────────────────────────────────
  if (useRouter) {
    const routed = route(question, readDb, nowIso);
    if (routed.kind === "direct") {
      return finish(routed.answer, "router", "answered", routed.intent);
    }
  }

  // ── 2. Model path ────────────────────────────────────────────────────────
  const history: unknown[] = [{ role: "user", content: question }];

  for (let step = 0; step < maxSteps; step++) {
    const turn = await provider.send({
      system: SYSTEM_PROMPT,
      tools: toolSchemas(),
      history,
    });

    usage.inputTokens += turn.usage.inputTokens;
    usage.outputTokens += turn.usage.outputTokens;
    usage.costUsd += provider.priceUsd(turn.usage.inputTokens, turn.usage.outputTokens);

    if (turn.stopReason === "refusal") {
      return finish(
        `The model declined to answer this request${turn.refusalCategory ? ` (${turn.refusalCategory})` : ""}.`,
        "model",
        "refusal",
      );
    }

    if (turn.toolCalls.length === 0) {
      return finish(turn.text || "No answer produced.", "model", turn.text ? "answered" : "no_answer");
    }

    history.push({ role: "assistant", content: turn.raw });

    const results: ToolResultMessage[] = [];
    for (const call of turn.toolCalls) {
      results.push(await dispatch(call, ctx, approver, steps, redactions));
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
  }

  return finish(
    "Stopped after reaching the tool-call limit without producing a final answer.",
    "model",
    "step_limit",
  );
}

async function dispatch(
  call: { id: string; name: string; input: Record<string, unknown> },
  ctx: ToolContext,
  approver: Approver,
  steps: StepRecord[],
  redactions: Record<string, number>,
): Promise<ToolResultMessage> {
  const startedAt = Date.now();
  const tool = TOOLS_BY_NAME.get(call.name);

  if (!tool) {
    steps.push({ tool: call.name, ok: false, detail: "unknown_tool", durationMs: 0 });
    return { toolUseId: call.id, content: `No tool named ${call.name}.`, isError: true };
  }

  // Mutating tools never execute on the model's say-so alone.
  if (tool.mutating) {
    const decision = await approver({
      tool: tool.name,
      input: call.input,
      summary: tool.summarise?.(call.input) ?? `${tool.name}(${JSON.stringify(call.input)})`,
    });

    if (!decision.approved) {
      steps.push({
        tool: call.name,
        ok: false,
        approved: false,
        detail: "approval_denied",
        durationMs: Date.now() - startedAt,
      });
      return {
        toolUseId: call.id,
        content: `Refused: a human did not approve this action. ${decision.reason ?? ""}`.trim(),
        isError: true,
      };
    }
    ctx.approvedBy = decision.decidedBy;
  }

  try {
    const output = tool.run(call.input, ctx);
    const { value, counts } = redactJson(output);
    mergeCounts(redactions, counts);

    steps.push({
      tool: call.name,
      ok: true,
      ...(tool.mutating ? { approved: true } : {}),
      durationMs: Date.now() - startedAt,
    });
    return { toolUseId: call.id, content: value, isError: false };
  } catch (err) {
    const message =
      err instanceof SqlGuardError
        ? `${err.code}: ${err.message}`
        : ((err as Error).message ?? "tool failed");

    steps.push({
      tool: call.name,
      ok: false,
      detail: message,
      durationMs: Date.now() - startedAt,
    });
    // Errors go back to the model as tool_result with is_error so it can
    // correct itself within the loop rather than the run aborting.
    return { toolUseId: call.id, content: message, isError: true };
  }
}

function mergeCounts(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}
