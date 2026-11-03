/**
 * HTTP API and queue worker in one process.
 *
 *   npm run serve
 *
 * They only share the database, so splitting them into two deployments later
 * is a config change.
 */
import { existsSync } from "node:fs";
import { createApp } from "./http/server.js";
import { Authenticator } from "./http/auth.js";
import { JobQueue } from "./queue/queue.js";
import { drain } from "./queue/worker.js";
import { createProvider } from "./providers/index.js";
import { DB_PATH, buildDatabase, NOW_MS } from "./db/seed.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. See .env.example: the server refuses to start unsecured.`,
    );
  }
  return value;
}

async function main(): Promise<void> {
  if (!existsSync(DB_PATH)) buildDatabase();

  const port = Number(process.env.PORT ?? 8080);
  const provider = createProvider(process.env.OPS_COPILOT_PROVIDER);
  // The demo database is seeded around a fixed clock, so "the last hour" only
  // means something against that clock. Point at real data with CLOCK=wall.
  const nowIso = process.env.OPS_COPILOT_CLOCK === "wall" ? undefined : new Date(NOW_MS).toISOString();

  // Fail fast rather than defaulting to an open endpoint: a webhook secret or
  // an issuer that quietly falls back to a placeholder is worse than no auth,
  // because it looks configured.
  const auth = new Authenticator({
    issuer: required("OIDC_ISSUER"),
    audience: required("OIDC_AUDIENCE"),
    jwksUri: process.env.OIDC_JWKS_URI,
  });
  const webhookSecret = required("WEBHOOK_SECRET");

  const app = createApp({
    dbPath: DB_PATH,
    provider,
    auth,
    webhookSecret,
    nowIso,
    askBurst: Number(process.env.OPS_COPILOT_ASK_BURST ?? 10),
    askPerMinute: Number(process.env.OPS_COPILOT_ASK_PER_MINUTE ?? 30),
  });

  app.listen(port, () => {
    console.log(`ops-copilot listening on :${port} (provider: ${provider.name})`);
  });

  const queue = JobQueue.open(DB_PATH);
  const tick = async () => {
    try {
      const n = await drain({ queue, dbPath: DB_PATH, provider, nowIso });
      if (n > 0) console.log(`worker: processed ${n} job(s)`);
    } catch (err) {
      // A worker that dies on one bad job stops draining the queue entirely.
      console.error(`worker error: ${(err as Error).message}`);
    }
  };

  const interval = setInterval(tick, 2_000);
  const shutdown = () => {
    clearInterval(interval);
    // Stop taking requests, let in-flight ones finish, then close the queue.
    app.close(() => {
      queue.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`\n${(err as Error).message}\n`);
  process.exitCode = 1;
});
