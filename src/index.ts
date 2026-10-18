/**
 * himalaya-mcp — Privacy-first email MCP server
 *
 * Wraps himalaya CLI via subprocess to provide email access
 * through MCP tools, resources, and prompts.
 *
 * Default transport is stdio (Claude Code plugin, Claude Desktop, Codex).
 * `node dist/index.js --http` or `MCP_TRANSPORT=http` serves Streamable HTTP.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

export { VERSION, NAME, TOOL_COUNT, createMcpServer } from "./server.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { httpModeRequested } = await import("./http-config.js");
  if (httpModeRequested(argv, process.env)) {
    const { serveFromArgv } = await import("./http.js");
    await serveFromArgv(argv, process.env);
    return;
  }

  // A token left in the environment must not reach the himalaya subprocess.
  delete process.env.MCP_BEARER_TOKEN;

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Start unconditionally: launchers that load this file through a wrapper
// (argv[1] is not this module) must still get a server. Import constants
// and factories from ./server.js instead of this module.
main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${message}`);
  process.exit(1);
});
