/**
 * Human-in-the-loop gate for tools that change state.
 *
 * Read tools execute freely. Any tool declared `mutating` is *not* executed when
 * the model asks for it — the call is suspended, an approval request is handed
 * to whoever is driving the agent, and the tool only runs on an explicit yes.
 *
 * The gate lives in the agent loop rather than inside each tool on purpose: a
 * tool that polices itself is one forgotten `if` away from not policing itself,
 * and every new tool would have to re-implement the same check correctly. Here
 * a tool is gated by virtue of its declaration, so the unsafe default is
 * impossible to reach by omission.
 */

export interface ApprovalRequest {
  tool: string;
  input: Record<string, unknown>;
  /** Human-readable summary of the effect, shown to the approver. */
  summary: string;
}

export interface ApprovalDecision {
  approved: boolean;
  /** Who or what decided, recorded on the resulting row for audit. */
  decidedBy: string;
  reason?: string;
}

export type Approver = (request: ApprovalRequest) => Promise<ApprovalDecision>;

/** Used by the eval harness and by CI, where no human is present. */
export const denyAll: Approver = async () => ({
  approved: false,
  decidedBy: "auto-deny",
  reason: "No approver attached; mutating tools are refused by default.",
});

/** Used only by eval cases that specifically exercise the approved path. */
export const approveAll: Approver = async () => ({
  approved: true,
  decidedBy: "eval-harness",
});

/** Interactive approver for the CLI. */
export function terminalApprover(
  ask: (question: string) => Promise<string>,
  operator = "cli-operator",
): Approver {
  return async (request) => {
    const answer = (
      await ask(`\n  APPROVAL REQUIRED\n  ${request.summary}\n  Proceed? [y/N] `)
    )
      .trim()
      .toLowerCase();

    const approved = answer === "y" || answer === "yes";
    return {
      approved,
      decidedBy: approved ? operator : "cli-operator-denied",
      reason: approved ? undefined : "Operator declined.",
    };
  };
}
