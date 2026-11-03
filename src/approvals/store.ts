/**
 * Pending state changes, decided by a second person.
 *
 * Flow over HTTP:
 *   1. /ask: the model calls issue_refund. The call is stored here as
 *      `pending` with its exact input, and the run ends.
 *   2. POST /approvals/:id by someone with ops:approve who is not the requester.
 *   3. Approve: the stored input runs. The model is not consulted again, so
 *      what was approved is exactly what executes.
 *
 * Execution is claim -> run -> record. The claim moves the row to `executing`
 * so two approvers clicking at once can't both run it. The tool itself is
 * idempotent on the approval id, so if the process dies after the refund but
 * before `executed` is recorded, approving again finishes the job instead of
 * paying twice.
 */
import { randomUUID } from "node:crypto";
import { immediate, openWritable, type DatabaseSyncInstance } from "../db/sqlite.js";
import { TOOLS_BY_NAME, ToolInputError } from "../tools/registry.js";
import { openToolContext } from "../tools/context.js";
import type { Approver } from "../guardrails/approval.js";

export const APPROVAL_TTL_MS = 30 * 60 * 1000;

export type ActionStatus = "pending" | "executing" | "executed" | "rejected" | "failed" | "expired";

export interface PendingAction {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  summary: string;
  requestedBy: string;
  runId: string;
  status: ActionStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  result: unknown;
  error: string | null;
  createdAt: string;
  expiresAt: string;
}

export class ApprovalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Approver for HTTP callers: nothing runs during /ask, everything is parked. */
export function pendingApprover(dbPath: string, requestedBy: string, now: () => number = Date.now): Approver {
  return async (req) => {
    const db = openWritable(dbPath);
    try {
      const id = randomUUID();
      const t = now();
      db.prepare(
        `INSERT INTO pending_actions (id, tool, input, summary, requested_by, run_id, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        id,
        req.tool,
        JSON.stringify(req.input),
        req.summary,
        requestedBy,
        req.runId,
        new Date(t).toISOString(),
        new Date(t + APPROVAL_TTL_MS).toISOString(),
      );
      return { status: "pending", approvalId: id, reason: "Waiting for a second approver." };
    } finally {
      db.close();
    }
  };
}

export function getAction(db: DatabaseSyncInstance, id: string): PendingAction | undefined {
  const row = db.prepare("SELECT * FROM pending_actions WHERE id = ?").get(id) as Row | undefined;
  return row && toAction(row);
}

export function listActions(db: DatabaseSyncInstance, status: ActionStatus = "pending", limit = 50): PendingAction[] {
  const rows = db
    .prepare("SELECT * FROM pending_actions WHERE status = ? ORDER BY created_at DESC LIMIT ?")
    .all(status, Math.min(Math.max(limit, 1), 200)) as unknown as Row[];
  return rows.map(toAction);
}

export async function decide(opts: {
  dbPath: string;
  id: string;
  decision: "approve" | "reject";
  approver: string;
  reason?: string;
  now?: () => number;
}): Promise<PendingAction> {
  const now = opts.now ?? Date.now;
  const db = openWritable(opts.dbPath);
  try {
    const claimed = immediate(db, () => {
      const action = getAction(db, opts.id);
      if (!action) throw new ApprovalError("No such approval.", 404, "not_found");

      const stamp = new Date(now()).toISOString();
      // `executing` is allowed back in: that's the crashed-mid-run case.
      if (action.status !== "pending" && action.status !== "executing") {
        throw new ApprovalError(`Approval is already ${action.status}.`, 409, "already_decided");
      }
      if (action.status === "pending" && action.expiresAt <= stamp) {
        db.prepare("UPDATE pending_actions SET status = 'expired' WHERE id = ?").run(action.id);
        throw new ApprovalError("Approval expired; ask the agent again.", 410, "expired");
      }
      if (action.requestedBy === opts.approver) {
        throw new ApprovalError("The requester can't approve their own action.", 403, "self_approval");
      }

      if (opts.decision === "reject") {
        db.prepare(
          "UPDATE pending_actions SET status = 'rejected', decided_by = ?, decided_at = ?, error = ? WHERE id = ?",
        ).run(opts.approver, stamp, opts.reason ?? null, action.id);
        return null;
      }

      db.prepare(
        "UPDATE pending_actions SET status = 'executing', decided_by = ?, decided_at = ? WHERE id = ?",
      ).run(opts.approver, stamp, action.id);
      return action;
    });

    if (claimed) await execute(opts.dbPath, db, claimed, opts.approver);
    return getAction(db, opts.id)!;
  } finally {
    db.close();
  }
}

async function execute(
  dbPath: string,
  db: DatabaseSyncInstance,
  action: PendingAction,
  approvedBy: string,
): Promise<void> {
  const tool = TOOLS_BY_NAME.get(action.tool);
  const ctx = openToolContext(dbPath, { writable: true });
  try {
    if (!tool?.mutating) throw new ToolInputError(`${action.tool} is not an approvable tool.`);
    const result = await tool.run(action.input, ctx, { approvedBy, idempotencyKey: `approval:${action.id}` });
    db.prepare("UPDATE pending_actions SET status = 'executed', result = ? WHERE id = ?").run(
      JSON.stringify(result),
      action.id,
    );
  } catch (err) {
    // Business-rule failures are final. Anything else (disk, lock timeout)
    // stays `executing` so it can be approved again.
    if (err instanceof ToolInputError) {
      db.prepare("UPDATE pending_actions SET status = 'failed', error = ? WHERE id = ?").run(err.message, action.id);
      return;
    }
    throw err;
  } finally {
    ctx.close();
  }
}

interface Row {
  id: string;
  tool: string;
  input: string;
  summary: string;
  requested_by: string;
  run_id: string;
  status: ActionStatus;
  decided_by: string | null;
  decided_at: string | null;
  result: string | null;
  error: string | null;
  created_at: string;
  expires_at: string;
}

function toAction(r: Row): PendingAction {
  return {
    id: r.id,
    tool: r.tool,
    input: JSON.parse(r.input),
    summary: r.summary,
    requestedBy: r.requested_by,
    runId: r.run_id,
    status: r.status,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    result: r.result ? JSON.parse(r.result) : null,
    error: r.error,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}
