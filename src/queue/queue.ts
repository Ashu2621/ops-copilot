/**
 * Durable job queue on SQLite.
 *
 * The webhook handler has to answer fast or senders retry and we triage the
 * same alert several times, so it enqueues and returns 202. Workers claim a
 * job by setting `locked_until`; if one dies mid-job the lease runs out and
 * another picks it up. Failures back off and eventually dead-letter.
 *
 * Redis/SQS would be the production choice. SQLite keeps `npm test` working
 * on a clean checkout, and the interface is small enough to swap.
 */
import { DatabaseSync, type DatabaseSyncInstance } from "../db/sqlite.js";

export interface Job {
  id: number;
  kind: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

export interface EnqueueOptions {
  maxAttempts?: number;
  /** Delay before the job first becomes claimable. */
  delayMs?: number;
}

/** Retry backoff: 1s, 4s, 9s, ... capped. Quadratic is gentle enough for
 *  transient failures without stalling a job for minutes on a fast queue. */
export function backoffMs(attempts: number): number {
  return Math.min(attempts * attempts * 1_000, 60_000);
}

export class JobQueue {
  constructor(
    private readonly db: DatabaseSyncInstance,
    private readonly now: () => number = Date.now,
  ) {}

  static open(dbPath: string, now?: () => number): JobQueue {
    return new JobQueue(new DatabaseSync(dbPath), now);
  }

  enqueue(kind: string, payload: unknown, opts: EnqueueOptions = {}): number {
    const nowIso = new Date(this.now()).toISOString();
    const runAfter = new Date(this.now() + (opts.delayMs ?? 0)).toISOString();

    const id =
      ((this.db.prepare("SELECT MAX(id) AS m FROM jobs").get() as { m: number | null }).m ?? 0) + 1;

    this.db
      .prepare(
        `INSERT INTO jobs (id, kind, payload, status, attempts, max_attempts,
                           run_after, locked_until, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', 0, ?, ?, NULL, ?, ?)`,
      )
      .run(id, kind, JSON.stringify(payload), opts.maxAttempts ?? 3, runAfter, nowIso, nowIso);

    return id;
  }

  /**
   * Atomically claim one runnable job.
   *
   * BEGIN IMMEDIATE takes the write lock up front, so two workers racing here
   * cannot both read the same row as claimable before either writes. Doing the
   * SELECT outside a write transaction is the classic way to hand one job to
   * two workers.
   */
  claim(visibilityMs = 30_000): Job | null {
    const nowIso = new Date(this.now()).toISOString();
    const lockUntil = new Date(this.now() + visibilityMs).toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT id, kind, payload, attempts, max_attempts
             FROM jobs
            WHERE run_after <= ?
              AND (status = 'queued'
                   OR (status = 'in_flight' AND locked_until IS NOT NULL AND locked_until <= ?))
            ORDER BY run_after, id
            LIMIT 1`,
        )
        .get(nowIso, nowIso) as
        | { id: number; kind: string; payload: string; attempts: number; max_attempts: number }
        | undefined;

      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }

      this.db
        .prepare(
          `UPDATE jobs SET status = 'in_flight', locked_until = ?, updated_at = ? WHERE id = ?`,
        )
        .run(lockUntil, nowIso, row.id);

      this.db.exec("COMMIT");

      return {
        id: row.id,
        kind: row.kind,
        payload: JSON.parse(row.payload),
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
      };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  complete(id: number, result: unknown): void {
    const nowIso = new Date(this.now()).toISOString();
    this.db
      .prepare(
        `UPDATE jobs
            SET status = 'done', result = ?, locked_until = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(JSON.stringify(result ?? null), nowIso, id);
  }

  /**
   * Record a failure. Retries with backoff until `max_attempts`, then parks the
   * job as `dead` rather than retrying forever: a poison message that loops
   * indefinitely will starve every healthy job behind it.
   */
  fail(id: number, error: string): "retrying" | "dead" {
    const nowIso = new Date(this.now()).toISOString();
    const row = this.db.prepare("SELECT attempts, max_attempts FROM jobs WHERE id = ?").get(id) as
      | { attempts: number; max_attempts: number }
      | undefined;
    if (!row) return "dead";

    const attempts = row.attempts + 1;

    if (attempts >= row.max_attempts) {
      this.db
        .prepare(
          `UPDATE jobs
              SET status = 'dead', attempts = ?, last_error = ?, locked_until = NULL, updated_at = ?
            WHERE id = ?`,
        )
        .run(attempts, error, nowIso, id);
      return "dead";
    }

    const runAfter = new Date(this.now() + backoffMs(attempts)).toISOString();
    this.db
      .prepare(
        `UPDATE jobs
            SET status = 'queued', attempts = ?, last_error = ?, run_after = ?,
                locked_until = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(attempts, error, runAfter, nowIso, id);
    return "retrying";
  }

  stats(): Record<string, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all() as
      Array<{ status: string; n: number }>;
    const out: Record<string, number> = { queued: 0, in_flight: 0, done: 0, dead: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  close(): void {
    this.db.close();
  }
}
