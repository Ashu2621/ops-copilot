/**
 * Alert triage as a LangGraph state machine.
 *
 * Unlike agent/loop.ts, the steps here are known up front: classify, gather
 * the evidence for that class, read the runbook, decide. A graph keeps each
 * step a small testable function and puts the round limit in the routing.
 * Nodes call tools directly; there's no reason to pay a model to rediscover
 * fixed rules on every alert.
 */
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { TOOLS_BY_NAME } from "../tools/registry.js";
import { openToolContext } from "../tools/context.js";
import { redactJson } from "../guardrails/pii.js";

export interface AlertInput {
  name: string;
  severity: "info" | "warning" | "critical";
  summary: string;
}

export type Category = "payments" | "latency" | "unknown";

/** How many evidence-gathering rounds before the graph gives up and escalates. */
export const MAX_ROUNDS = 3;

const TriageState = Annotation.Root({
  alert: Annotation<AlertInput>(),
  dbPath: Annotation<string>(),

  category: Annotation<Category>({
    reducer: (_prev, next) => next,
    default: () => "unknown",
  }),

  /** Accumulates across rounds: the one channel that appends rather than replaces. */
  evidence: Annotation<string[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),

  guidance: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),

  rounds: Annotation<number>({
    reducer: (prev, next) => prev + next,
    default: () => 0,
  }),

  verdict: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),

  needsHuman: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),

  /** Node names in the order they ran: the graph's own audit trail. */
  path: Annotation<string[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
});

export type TriageResult = typeof TriageState.State;

async function callTool(dbPath: string, name: string, input: Record<string, unknown>): Promise<string> {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) return `No tool named ${name}.`;

  // Triage gathers evidence and recommends. It never acts, so mutating tools
  // aren't reachable from here at all.
  if (tool.mutating) return `${name} is not available to triage.`;

  const ctx = openToolContext(dbPath, { writable: false });
  try {
    return redactJson(await tool.run(input, ctx)).value;
  } catch (err) {
    return `error: ${(err as Error).message}`;
  } finally {
    ctx.close();
  }
}

// ── Nodes ────────────────────────────────────────────────────────────────────

/** Deterministic classification. The alert name is written by us, not a user. */
export function classify(alert: AlertInput): Category {
  const text = `${alert.name} ${alert.summary}`.toLowerCase();
  if (/payment|charge|refund|decline|gateway/.test(text)) return "payments";
  if (/latency|slow|p95|timeout|throughput/.test(text)) return "latency";
  return "unknown";
}

const classifyNode = (state: TriageResult) => ({
  category: classify(state.alert),
  path: ["classify"],
});

const gatherPayments = async (state: TriageResult) => ({
  evidence: [
    await callTool(state.dbPath, "run_sql", {
      sql: "SELECT failure_code, COUNT(*) AS n FROM payments WHERE status = 'failed' GROUP BY failure_code ORDER BY n DESC",
    }),
  ],
  rounds: 1,
  path: ["gather:payments"],
});

const gatherLatency = async (state: TriageResult) => ({
  evidence: [
    await callTool(state.dbPath, "get_metric_series", {
      metric: "checkout_p95_latency_ms",
      hours: 12,
    }),
    // Latency without throughput is unreadable: the same number means "we are
    // overloaded" or "something is stuck" depending on whether traffic moved.
    await callTool(state.dbPath, "get_metric_series", { metric: "orders_per_minute", hours: 12 }),
  ],
  rounds: 1,
  path: ["gather:latency"],
});

const gatherBroad = async (state: TriageResult) => ({
  evidence: [
    await callTool(state.dbPath, "get_metric_series", { metric: "payment_error_rate", hours: 6 }),
    await callTool(state.dbPath, "run_sql", { sql: "SELECT COUNT(*) AS pending FROM orders WHERE status = 'pending'" }),
  ],
  rounds: 1,
  path: ["gather:broad"],
});

const consultRunbook = async (state: TriageResult) => ({
  guidance: await callTool(state.dbPath, "search_runbook", {
    query: `${state.alert.name} ${state.alert.summary}`,
    top_k: 2,
  }),
  path: ["runbook"],
});

const decideNode = (state: TriageResult) => {
  const hasEvidence = state.evidence.some((e) => e.length > 0 && !e.startsWith("error:"));
  const hasGuidance = state.guidance.length > 0 && state.guidance.includes("matches");

  if (hasEvidence && hasGuidance) {
    return {
      verdict: `Triaged as ${state.category} after ${state.rounds} round(s). Evidence gathered and runbook guidance found.`,
      needsHuman: state.alert.severity === "critical",
      path: ["decide:resolved"],
    };
  }
  return { path: ["decide:insufficient"] };
};

const escalateNode = (state: TriageResult) => ({
  verdict: `Could not triage automatically after ${state.rounds} round(s); escalating to a human.`,
  needsHuman: true,
  path: ["escalate"],
});

// ── Edges ────────────────────────────────────────────────────────────────────

const routeByCategory = (state: TriageResult): "payments" | "latency" | "broad" =>
  state.category === "payments" ? "payments" : state.category === "latency" ? "latency" : "broad";

/**
 * After deciding: finish, try another round, or escalate.
 *
 * The round cap lives here rather than inside a node because it is a property
 * of the workflow, not of any single step, and because a loop whose bound is
 * buried in the body is a loop nobody can see the shape of.
 */
const routeAfterDecision = (state: TriageResult): "done" | "again" | "escalate" => {
  if (state.verdict) return "done";
  if (state.rounds >= MAX_ROUNDS) return "escalate";
  return "again";
};

export function buildTriageGraph() {
  return new StateGraph(TriageState)
    .addNode("classify", classifyNode)
    .addNode("payments", gatherPayments)
    .addNode("latency", gatherLatency)
    .addNode("broad", gatherBroad)
    .addNode("runbook", consultRunbook)
    .addNode("decide", decideNode)
    .addNode("escalate", escalateNode)
    .addEdge(START, "classify")
    .addConditionalEdges("classify", routeByCategory, {
      payments: "payments",
      latency: "latency",
      broad: "broad",
    })
    .addEdge("payments", "runbook")
    .addEdge("latency", "runbook")
    .addEdge("broad", "runbook")
    .addEdge("runbook", "decide")
    .addConditionalEdges("decide", routeAfterDecision, {
      done: END,
      again: "broad",
      escalate: "escalate",
    })
    .addEdge("escalate", END)
    .compile();
}

export async function triage(alert: AlertInput, dbPath: string): Promise<TriageResult> {
  const graph = buildTriageGraph();
  return (await graph.invoke({ alert, dbPath })) as TriageResult;
}
