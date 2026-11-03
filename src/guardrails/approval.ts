/**
 * Human approval for tools that change state.
 *
 * The agent loop calls an Approver for every mutating tool call, with the
 * exact input the model produced. The approver sees that one action and
 * answers for that one action. There is no "allow writes for this run" flag.
 *
 * Three outcomes:
 *   approved  someone looked at this call and said yes (CLI prompt, evals)
 *   denied    nobody can approve here, or they said no
 *   pending   parked for a second person; see approvals/store.ts
 */

export interface ApprovalRequest {
  runId: string;
  tool: string;
  input: Record<string, unknown>;
  /** What the approver is shown. */
  summary: string;
}

export type ApprovalDecision =
  | { status: "approved"; decidedBy: string }
  | { status: "denied"; decidedBy: string; reason: string }
  | { status: "pending"; approvalId: string; reason: string };

export type Approver = (request: ApprovalRequest) => Promise<ApprovalDecision>;

/** Default everywhere no human is attached: evals, CI, MCP. */
export const denyAll: Approver = async () => ({
  status: "denied",
  decidedBy: "auto-deny",
  reason: "No approver attached; mutating tools are refused by default.",
});

/** Only for eval cases that test the approved path. */
export const approveAll: Approver = async () => ({ status: "approved", decidedBy: "eval-harness" });

/** Asks the operator at the terminal, once per action. */
export function terminalApprover(ask: (question: string) => Promise<string>, operator: string): Approver {
  return async (request) => {
    const answer = (await ask(`\n  APPROVAL REQUIRED\n  ${request.summary}\n  Proceed? [y/N] `))
      .trim()
      .toLowerCase();

    if (answer === "y" || answer === "yes") return { status: "approved", decidedBy: operator };
    return { status: "denied", decidedBy: operator, reason: "Operator declined." };
  };
}
