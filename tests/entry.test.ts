/**
 * Entry-point behavior of the shipped bundle (esbuild of src/index.ts).
 *
 * - The stdio server must start even when the bundle is loaded by a wrapper
 *   whose argv[1] is not the bundle (built-in runtimes, process managers).
 * - `--http` must serve tools in remote mode, so the production listener,
 *   not just the test factory, refuses host-file writes.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const TOKEN = "0123456789abcdef0123456789abcdef";
const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "entry-test", version: "0" } },
};

let dir: string;
let bundle: string;
const children: ChildProcess[] = [];

function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, HIMALAYA_CONFIG: "/nonexistent/himalaya/config.toml", MCP_TRANSPORT: "" };
}

/** Resolve with the first chunk on the stream that matches. */
function waitFor(stream: NodeJS.ReadableStream, pattern: RegExp, timeoutMs = 10_000): Promise<RegExpMatchArray> {
  return new Promise((resolvePromise, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}; got: ${buffer}`)), timeoutMs);
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(pattern);
      if (match) {
        clearTimeout(timer);
        resolvePromise(match);
      }
    });
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hmcp-entry-"));
  bundle = join(dir, "index.js");
  await build({
    entryPoints: [join(ROOT, "src/index.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: bundle,
    logLevel: "silent",
  });
});

afterAll(() => {
  for (const child of children) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

describe("bundle entry point", () => {
  it("starts the stdio server when loaded through a wrapper module", async () => {
    const wrapper = join(dir, "wrapper.mjs");
    writeFileSync(wrapper, `await import(${JSON.stringify(pathToFileURL(bundle).href)});\n`);
    const child = spawn(process.execPath, [wrapper], { env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);

    const reply = waitFor(child.stdout!, /^(.*)\n/);
    child.stdin!.write(`${JSON.stringify(INIT)}\n`);
    const [, line] = await reply;
    expect(JSON.parse(line)).toMatchObject({ id: 1, result: { serverInfo: { name: "himalaya-mcp" } } });
  });

  it("serves --http in remote mode", async () => {
    const child = spawn(process.execPath, [bundle, "--http", "--port", "0"], {
      env: { ...childEnv(), MCP_BEARER_TOKEN: TOKEN },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const [, url] = await waitFor(child.stderr!, /listening on (http:\/\/\S+)/);

    const destination = join(dir, "authorized_keys");
    const response = await fetch(url!, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "create_action_item", arguments: { id: "1", destination } },
      }),
    });
    const body = (await response.json()) as { result?: { isError?: boolean; content?: { text: string }[] } };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toMatch(/disabled over HTTP/);
    expect(existsSync(destination)).toBe(false);
  });
});
