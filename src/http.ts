/**
 * Streamable HTTP MCP listener guarded by a bearer token.
 *
 * Composio custom MCP registers `app_url` (this server's public HTTPS URL,
 * usually `https://<host>/mcp`) with API-key auth:
 *   Authorization: Bearer {{generic_api_key}}
 * The connected-account credential is the same value as MCP_BEARER_TOKEN.
 *
 * Each POST uses a new stateless transport. Composio and other proxies open
 * a fresh HTTP call per JSON-RPC message and do not pin a session id.
 * JSON responses are the default; `--sse` switches POST replies to SSE.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NAME, createMcpServerFactory } from "./server.js";
import {
  bearerTokenMatches,
  loadHttpServeConfig,
  type HttpServeConfig,
} from "./http-config.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
  "Access-Control-Max-Age": "86400",
};

export async function serveFromArgv(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = loadHttpServeConfig(argv, env);
  const httpServer = await startHttpServer(config, createMcpServerFactory({ remote: true }));
  console.error(formatListenLine(config, boundPort(httpServer)));

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      httpServer.closeAllConnections();
      httpServer.close(() => resolve());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

export function startHttpServer(
  config: HttpServeConfig,
  createServerInstance: () => McpServer,
): Promise<Server> {
  const httpServer = createServer((req, res) => {
    void handleHttpRequest(req, res, config, createServerInstance).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`himalaya-mcp: request failed: ${message}`);
      if (!res.headersSent) {
        const status = message === "payload too large" ? 413 : 500;
        writeJson(res, status, {
          jsonrpc: "2.0",
          error: { code: -32603, message: status === 413 ? "Payload too large" : "Internal error" },
          id: null,
        });
      } else {
        res.destroy();
      }
    });
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    httpServer.once("error", onError);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off("error", onError);
      resolve(httpServer);
    });
  });
}

export function formatListenLine(config: HttpServeConfig, port: number): string {
  const displayHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
  const lines = [
    `himalaya-mcp HTTP listening on http://${displayHost}:${port}${config.path}`,
    `bind ${config.host}:${port}`,
    "Send Authorization: Bearer <token> on every MCP request.",
    "Composio custom MCP auth scheme:",
    '  { "mode": "API_KEY", "headers": { "Authorization": "Bearer {{generic_api_key}}" } }',
    "Composio requires a public HTTPS URL. Terminate TLS with a reverse proxy or tunnel pointed at this port.",
  ];
  if (config.host === "127.0.0.1" || config.host === "localhost" || config.host === "::1") {
    lines.push("Bound to loopback. Pass --host 0.0.0.0 to accept connections from other machines.");
  } else {
    lines.push("Bound beyond loopback. The bearer token is the access check.");
  }
  return lines.join("\n");
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: HttpServeConfig,
  createServerInstance: () => McpServer,
): Promise<void> {
  const path = requestPath(req.url);

  if (req.method === "GET" && path === "/health") {
    writeJson(res, 200, { status: "ok", name: NAME });
    return;
  }
  if (req.method === "GET" && path === "/") {
    writeJson(res, 200, { name: NAME, mcp: config.path, auth: "bearer" });
    return;
  }
  if (path !== config.path) {
    writeJson(res, 404, { error: "not_found" });
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...CORS_HEADERS, "Content-Length": "0", "Cache-Control": "no-store" });
    res.end();
    return;
  }

  if (!bearerTokenMatches(headerOne(req.headers.authorization), config.token)) {
    console.error("himalaya-mcp: rejected unauthorized request");
    writeJson(
      res,
      401,
      { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null },
      {
        "WWW-Authenticate": 'Bearer realm="himalaya-mcp", error="invalid_token"',
      },
    );
    return;
  }

  // Standalone SSE is optional. JSON mode answers 405 so Streamable HTTP
  // clients continue with POST. `--sse` opens the long-lived GET stream.
  if (req.method === "GET" && config.jsonResponse) {
    writeJson(
      res,
      405,
      { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
      { Allow: "POST, DELETE, OPTIONS" },
    );
    return;
  }

  if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
    writeJson(
      res,
      405,
      { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
      { Allow: "GET, POST, DELETE, OPTIONS" },
    );
    return;
  }

  let parsedBody: unknown;
  if (req.method === "POST") {
    const raw = await readBody(req, MAX_BODY_BYTES);
    if (raw.length === 0) {
      writeJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error: empty body" },
        id: null,
      });
      return;
    }
    try {
      parsedBody = JSON.parse(raw.toString("utf8")) as unknown;
    } catch {
      writeJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error: Invalid JSON" },
        id: null,
      });
      return;
    }
    ensureStreamableHeaders(req);
  }

  const mcp = createServerInstance();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: config.jsonResponse,
  });
  let closed = false;
  const closeBoth = () => {
    if (closed) return;
    closed = true;
    void transport.close().catch(() => undefined);
    void mcp.close().catch(() => undefined);
  };
  res.on("close", closeBoth);

  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
    await mcp.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } finally {
    if (res.writableEnded) closeBoth();
  }
}

function ensureStreamableHeaders(req: IncomingMessage): void {
  // @hono/node-server copies rawHeaders, not the normalized headers map.
  const accept = headerOne(req.headers.accept);
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
    setRawHeader(req, "accept", "application/json, text/event-stream");
  }
  const contentType = headerOne(req.headers["content-type"]);
  if (!contentType.includes("application/json")) {
    setRawHeader(req, "content-type", "application/json");
  }
}

function setRawHeader(req: IncomingMessage, name: string, value: string): void {
  req.headers[name.toLowerCase()] = value;
  const raw = req.rawHeaders;
  let found = false;
  for (let i = 0; i < raw.length; i += 2) {
    if ((raw[i] ?? "").toLowerCase() === name) {
      raw[i + 1] = value;
      found = true;
    }
  }
  if (!found) raw.push(name, value);
}

function requestPath(url: string | undefined): string {
  const raw = url ?? "/";
  const end = raw.search(/[?#]/);
  const path = end === -1 ? raw : raw.slice(0, end);
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path || "/";
}

function headerOne(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(headerOne(req.headers["content-length"]));
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    return Promise.reject(new Error("payload too large"));
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        fail(new Error("payload too large"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error) => fail(error);
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
    ...extra,
  });
  res.end(payload);
}

function boundPort(server: Server): number {
  const address = server.address();
  if (address && typeof address === "object") return address.port;
  return 0;
}
