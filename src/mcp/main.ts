/**
 * MCP stdio entry point.
 *
 *   npm run mcp
 *
 * Register with an MCP client (e.g. Claude Desktop) as:
 *   { "command": "npx", "args": ["tsx", "src/mcp/main.ts"], "cwd": "<repo>" }
 *
 * Nothing is written to stdout except protocol frames: stdout IS the
 * transport here, so a stray console.log corrupts the session.
 */
import { main } from "./server.js";

main().catch((err) => {
  process.stderr.write(`mcp server failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
