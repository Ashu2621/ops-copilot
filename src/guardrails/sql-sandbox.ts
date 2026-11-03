/**
 * Runs model-written SQL on a worker thread with a timeout.
 *
 * node:sqlite is synchronous. On the main thread, one bad join from the model
 * blocks the HTTP server for every other caller until it finishes. Here the
 * query runs on its own thread with its own read-only handle, and the caller
 * gets a `query_timeout` error back after QUERY_TIMEOUT_MS.
 *
 * Known limit: Worker.terminate() can't interrupt SQLite mid-step, so a
 * timed-out query keeps one core busy until its current step returns. The
 * row cap in boundedQuery keeps that window short for most shapes. A
 * progress handler would fix it properly once node:sqlite exposes one.
 */
import { Worker } from "node:worker_threads";
import { SqlGuardError, QUERY_TIMEOUT_MS, boundedQuery } from "./sql.js";

// Plain CommonJS so it runs as an eval worker under both tsx and Vitest.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.dbPath, { readOnly: true });
parentPort.on("message", ({ id, sql }) => {
  try {
    const rows = db.prepare(sql).all().map((r) => ({ ...r }));
    parentPort.postMessage({ id, rows });
  } catch (err) {
    parentPort.postMessage({ id, error: String((err && err.message) || err) });
  }
});
`;

type Reply = { id: number; rows?: Record<string, unknown>[]; error?: string };

export class SqlSandbox {
  private worker: Worker | null = null;
  private nextId = 1;

  constructor(
    private readonly dbPath: string,
    private readonly timeoutMs = QUERY_TIMEOUT_MS,
  ) {}

  async query(sql: string): Promise<Record<string, unknown>[]> {
    const worker = this.ensureWorker();
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        // The worker may still be inside SQLite. Drop it and start fresh next time.
        this.kill();
        reject(
          new SqlGuardError(
            `Query took longer than ${this.timeoutMs} ms and was cancelled. Narrow it with a WHERE clause or an aggregate.`,
            "query_timeout",
          ),
        );
      }, this.timeoutMs);

      const onMessage = (msg: Reply) => {
        if (msg.id !== id) return;
        cleanup();
        if (msg.error !== undefined) {
          reject(new SqlGuardError(`Query rejected by the database: ${msg.error}`, "engine_rejected"));
        } else {
          resolve(msg.rows ?? []);
        }
      };
      const onError = (err: Error) => {
        cleanup();
        this.worker = null;
        reject(err);
      };
      const cleanup = () => {
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", onError);
      };

      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.postMessage({ id, sql: boundedQuery(sql) });
    });
  }

  close(): void {
    this.kill();
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { dbPath: this.dbPath } });
      this.worker.unref();
    }
    return this.worker;
  }

  private kill(): void {
    const w = this.worker;
    this.worker = null;
    if (w) void w.terminate();
  }
}
