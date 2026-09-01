/**
 * Runs the HTTP surface and the queue worker in one process.
 *
 *   npm run serve
 *
 * Co-locating them is a deployment choice, not an architectural one: the worker
 * only shares the database with the API, so splitting them into separate
 * processes later is a config change rather than a rewrite. One process is
 * simply the right size until there is a reason for two.
 */
import { existsSync } from "node:fs";
import { createApp } from "./http/server.js";
import { Authenticator } from "./http/auth.js";
import { JobQueue } from "./queue/queue.js";
import { drain } from "./queue/worker.js";
import { MockProvider } from "./providers/mock.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAIProvider } from "./providers/openai.js";
import { DB_PATH, buildDatabase, NOW_MS } from "./db/seed.js";
import type { ModelProvider } from "./providers/types.js";

function providerFrom(name: string | undefined): ModelProvider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return new OpenAIProvider();
    default:
      return new MockProvider();
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. See .env.example — the server refuses to start unsecured.`,
    );
  }
  return value;
}

async function main(): Promise<void> {
  if (!existsSync(DB_PATH)) buildDatabase();

  const port = Number(process.env.PORT ?? 8080);
  const provider = providerFrom(process.env.OPS_COPILOT_PROVIDER);

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
    nowIso: new Date(NOW_MS).toISOString(),
  });

  app.listen(port, () => {
    console.log(`ops-copilot listening on :${port} (provider: ${provider.name})`);
  });

  const queue = JobQueue.open(DB_PATH);
  const tick = async () => {
    try {
      const n = await drain({ queue, dbPath: DB_PATH, provider, nowIso: new Date(NOW_MS).toISOString() });
      if (n > 0) console.log(`worker: processed ${n} job(s)`);
    } catch (err) {
      // A worker that dies on one bad job stops draining the queue entirely.
      console.error(`worker error: ${(err as Error).message}`);
    }
  };

  const interval = setInterval(tick, 2_000);
  const shutdown = () => {
    clearInterval(interval);
    queue.close();
    app.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`\n${(err as Error).message}\n`);
  process.exitCode = 1;
});
