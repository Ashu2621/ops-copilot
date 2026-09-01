/**
 * Alert triage as an explicit state graph.
 *
 * DESIGN NOTE — why this is not the agent loop, and why the agent loop stays.
 *
 * The two solve different shapes of problem, and using either for the other's
 * job is the mistake worth avoiding:
 *
 *   agent/loop.ts   an open question. Nobody knows in advance which tools are
 *                   needed or in what order, so the model decides each step.
 *                   The shape is discovered at runtime.
 *
 *   this file       alert triage. The shape IS known in advance — classify the
 *                   alert, gather the evidence that class needs, consult the
 *                   runbook, decide. What varies is which branch runs and how
 *                   many rounds it takes, not what the steps are.
 *
 * Written as a flat function, that shape becomes nested conditionals plus a
 * hand-maintained round counter, and testing one branch means running the whole
 * thing. As a graph it is a declared set of nodes and edges: each node is a
 * plain function that can be tested on its own, the branching is data, and the
 * recursion bound is enforced by the runtime rather than by a counter I have to
 * remember to increment.
 *
 * The nodes call tools directly rather than asking a model what to do next. The
 * routing rules here are known and cheap to evaluate, and paying a model to
 * rediscover them on every alert would be the same mistake agent/router.ts
 * exists to avoid.
 */
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { DatabaseSync } from "../db/sqlite.js";
import { TOOLS_BY_NAME, type ToolContext } from "../tools/registry.js";
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

  /** Accumulates across rounds — the one channel that appends rather than replaces. */
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

  /** Node names in the order they ran — the graph's own audit trail. */
  path: Annotation<string[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
});

export type TriageResult = typeof TriageState.State;

function callTool(dbPath: string, name: string, input: Record<string, unknown>): string {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) return `No tool named ${name}.`;

  // Mutating tools are unreachable from here by construction: triage gathers
  // evidence and recommends, it never acts. A graph that could issue a refund
  // would be a second door past the approval gate.
  if (tool.mutating) return `${name} is not available to triage.`;

  const readDb = new DatabaseSync(dbPath, { readOnly: true });
  const ctx: ToolContext = {
    readDb,
    writeDb: () => {
      throw new Error("Triage has no write access.");
    },
  };
  try {
    return redactJson(tool.run(input, ctx)).value;
  } catch (err) {
    return `error: ${(err as Error).message}`;
  } finally {
    readDb.close();
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

const gatherPayments = (state: TriageResult) => ({
  evidence: [
    callTool(state.dbPath, "run_sql", {
      sql: "SELECT failure_code, COUNT(*) AS n FROM payments WHERE status = 'failed' GROUP BY failure_code ORDER BY n DESC",
    }),
  ],
  rounds: 1,
  path: ["gather:payments"],
});

const gatherLatency = (state: TriageResult) => ({
  evidence: [
    callTool(state.dbPath, "get_metric_series", {
      metric: "checkout_p95_latency_ms",
      hours: 12,
    }),
    // Latency without throughput is unreadable: the same number means "we are
    // overloaded" or "something is stuck" depending on whether traffic moved.
    callTool(state.dbPath, "get_metric_series", { metric: "orders_per_minute", hours: 12 }),
  ],
  rounds: 1,
  path: ["gather:latency"],
});

const gatherBroad = (state: TriageResult) => ({
  evidence: [
    callTool(state.dbPath, "get_metric_series", { metric: "payment_error_rate", hours: 6 }),
    callTool(state.dbPath, "run_sql", { sql: "SELECT COUNT(*) AS pending FROM orders WHERE status = 'pending'" }),
  ],
  rounds: 1,
  path: ["gather:broad"],
});

const consultRunbook = (state: TriageResult) => ({
  guidance: callTool(state.dbPath, "search_runbook", {
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
 * of the workflow, not of any single step — and because a loop whose bound is
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
