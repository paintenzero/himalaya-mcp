/**
 * Configuration for the network MCP listener.
 *
 * HTTP mode is opt-in. The Claude plugin and `node dist/index.js` stay on
 * stdio unless `--http`, `--transport http`, or `MCP_TRANSPORT=http` is set.
 * The bearer token is removed from the environment object passed in so a
 * later himalaya subprocess does not inherit it.
 */

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export const MIN_BEARER_TOKEN_LENGTH = 16;
export const MAX_BEARER_TOKEN_LENGTH = 4096;
export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 8080;
export const DEFAULT_HTTP_PATH = "/mcp";

const VALUE_FLAGS = new Set(["host", "port", "path", "token", "token-file", "transport"]);
const BOOL_FLAGS = new Set(["http", "sse"]);

export class HttpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpConfigError";
  }
}

export interface HttpServeConfig {
  host: string;
  port: number;
  /** Absolute path of the MCP endpoint, without a trailing slash. */
  path: string;
  token: string;
  /** When true, POST responses are a single JSON body instead of an SSE stream. */
  jsonResponse: boolean;
}

export function httpModeRequested(argv: string[], env: NodeJS.ProcessEnv): boolean {
  if (argv.includes("--http")) return true;
  const transport = readFlag(argv, "transport") ?? env.MCP_TRANSPORT;
  return transport === "http";
}

/**
 * Parse HTTP listener settings.
 *
 * Deletes `MCP_BEARER_TOKEN` from `env` even when the caller only needed the
 * scrub, so a later himalaya subprocess does not inherit the secret.
 */
export function loadHttpServeConfig(argv: string[], env: NodeJS.ProcessEnv): HttpServeConfig {
  assertKnownArgs(argv);

  const envToken = env.MCP_BEARER_TOKEN;
  delete env.MCP_BEARER_TOKEN;

  const host = readFlag(argv, "host") ?? env.MCP_HOST ?? DEFAULT_HTTP_HOST;
  const portRaw = readFlag(argv, "port") ?? env.MCP_PORT ?? String(DEFAULT_HTTP_PORT);
  const pathRaw = readFlag(argv, "path") ?? env.MCP_PATH ?? DEFAULT_HTTP_PATH;
  const jsonResponse = !argv.includes("--sse") && env.MCP_HTTP_JSON !== "false" && env.MCP_HTTP_JSON !== "0";

  if (!host.trim()) {
    throw new HttpConfigError("HTTP host is empty. Set --host or MCP_HOST.");
  }

  return {
    host,
    port: parsePort(portRaw),
    path: normalizeMcpPath(pathRaw),
    token: resolveToken(argv, env, envToken),
    jsonResponse,
  };
}

/** Constant-time check of an `Authorization: Bearer` header. */
export function bearerTokenMatches(authorization: string | undefined, expected: string): boolean {
  const provided = parseBearer(authorization);
  const got = Buffer.from(provided ?? "");
  const want = Buffer.from(expected);
  if (got.length !== want.length) {
    timingSafeEqual(want, want);
    return false;
  }
  return timingSafeEqual(got, want);
}

function parseBearer(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization.trim());
  return match?.[1];
}

function resolveToken(argv: string[], env: NodeJS.ProcessEnv, envToken: string | undefined): string {
  let token = readFlag(argv, "token") ?? envToken;
  const tokenFile = readFlag(argv, "token-file") ?? env.MCP_BEARER_TOKEN_FILE;
  if ((token === undefined || token.trim() === "") && tokenFile) {
    try {
      token = readFileSync(tokenFile, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new HttpConfigError(`Could not read bearer token file: ${detail}`);
    }
  }

  token = token?.trim();
  if (!token) {
    throw new HttpConfigError(
      "HTTP mode requires a bearer token. Set MCP_BEARER_TOKEN (16+ characters) or MCP_BEARER_TOKEN_FILE. " +
        "Composio sends it as Authorization: Bearer <token>.",
    );
  }
  if (token.length < MIN_BEARER_TOKEN_LENGTH) {
    throw new HttpConfigError(
      `Bearer token must be at least ${MIN_BEARER_TOKEN_LENGTH} characters.`,
    );
  }
  if (token.length > MAX_BEARER_TOKEN_LENGTH) {
    throw new HttpConfigError(`Bearer token must be at most ${MAX_BEARER_TOKEN_LENGTH} characters.`);
  }
  return token;
}

function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new HttpConfigError(`Invalid port "${raw}". Use an integer from 0 to 65535.`);
  }
  const port = Number(raw);
  if (port > 65535) {
    throw new HttpConfigError(`Invalid port "${raw}". Use an integer from 0 to 65535.`);
  }
  return port;
}

function normalizeMcpPath(path: string): string {
  if (!path.startsWith("/")) {
    throw new HttpConfigError(`MCP path must start with /. Got "${path}".`);
  }
  if (path.includes("?") || path.includes("#") || path.includes("\\") || path.includes("..")) {
    throw new HttpConfigError(`Invalid MCP path "${path}".`);
  }
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (trimmed === "/health" || trimmed === "/") {
    throw new HttpConfigError(`MCP path cannot be ${trimmed}.`);
  }
  return trimmed;
}

function readFlag(argv: string[], name: string): string | undefined {
  let value: string | undefined;
  const eqPrefix = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg.startsWith(eqPrefix)) {
      value = arg.slice(eqPrefix.length);
      continue;
    }
    if (arg === `--${name}`) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new HttpConfigError(`Option --${name} needs a value.`);
      }
      value = next;
      i++;
    }
  }
  return value;
}

function assertKnownArgs(argv: string[]): void {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      throw new HttpConfigError(`Unexpected argument "${arg}".`);
    }
    const name = arg.includes("=") ? arg.slice(2, arg.indexOf("=")) : arg.slice(2);
    if (BOOL_FLAGS.has(name)) continue;
    if (!VALUE_FLAGS.has(name)) {
      throw new HttpConfigError(`Unknown option --${name}.`);
    }
    if (!arg.includes("=")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new HttpConfigError(`Option --${name} needs a value.`);
      }
      i++;
    }
  }
}
