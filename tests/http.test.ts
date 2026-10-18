/**
 * Streamable HTTP listener: bearer gate, stateless JSON-RPC, and the
 * official MCP client handshake Composio-style proxies use.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { printHelp } from "../src/cli/shared.js";
import {
  bearerTokenMatches,
  HttpConfigError,
  httpModeRequested,
  loadHttpServeConfig,
} from "../src/http-config.js";
import { startHttpServer } from "../src/http.js";
import { createMcpServerFactory, TOOL_COUNT } from "../src/server.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("HTTP config", () => {
  it("stays on stdio unless HTTP is requested", () => {
    expect(httpModeRequested([], {})).toBe(false);
    expect(httpModeRequested(["--http"], {})).toBe(true);
    expect(httpModeRequested(["--transport", "http"], {})).toBe(true);
    expect(httpModeRequested(["--transport=http"], {})).toBe(true);
    expect(httpModeRequested([], { MCP_TRANSPORT: "http" })).toBe(true);
    expect(httpModeRequested([], { MCP_TRANSPORT: "stdio" })).toBe(false);
  });

  it("requires a long bearer token and scrubs it from the environment", () => {
    const env: NodeJS.ProcessEnv = { MCP_BEARER_TOKEN: TOKEN, MCP_PORT: "9090" };
    const config = loadHttpServeConfig(["--http"], env);
    expect(config.token).toBe(TOKEN);
    expect(config.port).toBe(9090);
    expect(config.host).toBe("127.0.0.1");
    expect(config.path).toBe("/mcp");
    expect(config.jsonResponse).toBe(true);
    expect(env.MCP_BEARER_TOKEN).toBeUndefined();
  });

  it("prefers an explicit flag over the environment", () => {
    const flagged = "z".repeat(24);
    const env: NodeJS.ProcessEnv = { MCP_BEARER_TOKEN: TOKEN, MCP_HOST: "0.0.0.0" };
    const config = loadHttpServeConfig(["--http", "--token", flagged, "--host", "localhost"], env);
    expect(config.token).toBe(flagged);
    expect(config.host).toBe("localhost");
    expect(env.MCP_BEARER_TOKEN).toBeUndefined();
  });

  it("reads a token file and trims a trailing newline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hmcp-token-"));
    const file = join(dir, "token");
    try {
      await writeFile(file, `${TOKEN}\n`);
      const config = loadHttpServeConfig(["--http"], { MCP_BEARER_TOKEN_FILE: file });
      expect(config.token).toBe(TOKEN);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a missing, short, or unknown configuration", () => {
    expect(() => loadHttpServeConfig(["--http"], {})).toThrow(HttpConfigError);
    expect(() => loadHttpServeConfig(["--http"], { MCP_BEARER_TOKEN: "too-short" })).toThrow(
      /at least 16/,
    );
    expect(() => loadHttpServeConfig(["--http", "--port", "nope"], { MCP_BEARER_TOKEN: TOKEN })).toThrow(
      /port/i,
    );
    expect(() => loadHttpServeConfig(["--http", "--path", "mcp"], { MCP_BEARER_TOKEN: TOKEN })).toThrow(
      /start with/,
    );
    expect(() => loadHttpServeConfig(["--http", "--wat"], { MCP_BEARER_TOKEN: TOKEN })).toThrow(
      /Unknown option/,
    );
  });

  it("compares bearer headers without accepting lookalikes", () => {
    expect(bearerTokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerTokenMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerTokenMatches(undefined, TOKEN)).toBe(false);
    expect(bearerTokenMatches(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(bearerTokenMatches(`Bearer ${TOKEN}extra`, TOKEN)).toBe(false);
    expect(bearerTokenMatches(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN)).toBe(false);
    expect(bearerTokenMatches(`Bearer ${"a".repeat(TOKEN.length)}`, TOKEN)).toBe(false);
  });

  it("documents serve in the CLI help", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printHelp();
    const text = log.mock.calls.map((call) => call.join(" ")).join("\n");
    log.mockRestore();
    expect(text).toContain("serve");
    expect(text).toContain("MCP_BEARER_TOKEN");
    expect(text).toContain("generic_api_key");
  });
});

describe("HTTP MCP server", () => {
  let server: Server;
  let base: string;
  const previousConfig = process.env.HIMALAYA_CONFIG;

  beforeAll(async () => {
    process.env.HIMALAYA_CONFIG = "/nonexistent/himalaya/config.toml";
    const env: NodeJS.ProcessEnv = { MCP_BEARER_TOKEN: TOKEN };
    const config = loadHttpServeConfig(["--http", "--port", "0"], env);
    server = await startHttpServer(config, createMcpServerFactory({ remote: true }));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP server did not bind a TCP port");
    }
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    if (previousConfig === undefined) delete process.env.HIMALAYA_CONFIG;
    else process.env.HIMALAYA_CONFIG = previousConfig;
  });

  async function post(
    path: string,
    body: unknown,
    token?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; json: unknown; headers: Headers }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...extraHeaders,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      // keep the raw body for the assertion
    }
    return { status: response.status, json, headers: response.headers };
  }

  it("answers liveness without a token and hides the mailbox", async () => {
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: "ok" });

    const root = await fetch(`${base}/`);
    await expect(root.json()).resolves.toMatchObject({ mcp: "/mcp", auth: "bearer" });

    const missing = await fetch(`${base}/other`);
    expect(missing.status).toBe(404);
  });

  it("rejects a missing or wrong bearer with the same 401", async () => {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const missing = await post("/mcp", body);
    const wrong = await post("/mcp", body, "not-the-real-token");
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(missing.json).toEqual(wrong.json);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    expect(JSON.stringify(missing.json)).not.toContain(TOKEN);
  });

  it("lists tools on a fresh request with no session", async () => {
    const listed = await post("/mcp", { jsonrpc: "2.0", id: 7, method: "tools/list" }, TOKEN);
    expect(listed.status).toBe(200);
    expect(listed.headers.get("content-type")).toContain("application/json");
    const tools = (listed.json as { result?: { tools?: { name: string }[] } }).result?.tools;
    expect(tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining(["list_emails", "send_email"]));
    expect(tools).toHaveLength(TOOL_COUNT);
  });

  it("accepts a client that omits the Streamable HTTP Accept header", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ jsonrpc: "2.0", id: 3, result: {} });
  });

  it("answers CORS preflight and refuses the standalone GET stream in JSON mode", async () => {
    const preflight = await fetch(`${base}/mcp`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");

    const open = await fetch(`${base}/mcp`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "text/event-stream" },
    });
    expect(open.status).toBe(405);
  });

  it("completes the MCP client handshake", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client({ name: "himalaya-http-test", version: "0.0.0" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(TOOL_COUNT);
      expect(listed.tools.map((tool) => tool.name)).toContain("health_check");
    } finally {
      await client.close();
    }
  });

  it("serves tools in remote mode: no host-file writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hmcp-http-dest-"));
    const destination = join(dir, "authorized_keys");
    try {
      const called = await post(
        "/mcp",
        {
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: { name: "create_action_item", arguments: { id: "1", destination } },
        },
        TOKEN,
      );
      expect(called.status).toBe(200);
      const result = (called.json as { result?: { isError?: boolean; content?: { text: string }[] } }).result;
      expect(result?.isError).toBe(true);
      expect(result?.content?.[0]?.text).toMatch(/disabled over HTTP/);
      expect(existsSync(destination)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an oversized body", async () => {
    const pad = "x".repeat(8 * 1024 * 1024);
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad } }),
    });
    expect(response.status).toBe(413);
  });
});
