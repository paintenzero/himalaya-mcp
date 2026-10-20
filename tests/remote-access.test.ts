/**
 * Host-filesystem limits for network callers (`himalaya-mcp serve`).
 *
 * Over HTTP, create_action_item must not write arbitrary paths, and
 * send_email / compose_email must not attach host files outside a
 * download_attachment directory, by `attachments` or by hand-written MML.
 * Stdio (remote unset) keeps its existing behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HimalayaClient } from "../src/himalaya/client.js";
import { registerActionTools } from "../src/tools/actions.js";
import { registerComposeTools } from "../src/tools/compose.js";
import { registerComposeNewTools } from "../src/tools/compose-new.js";
import { DOWNLOAD_DIR_PREFIX, remoteMmlError, resolveRemoteAttachments } from "../src/tools/_remote.js";

const ENVELOPES = JSON.stringify([
  { id: "1", flags: [], subject: "Hi", from: { name: "A", addr: "a@example.com" }, to: { name: null, addr: "me@example.com" }, date: "2026-01-01", has_attachment: false },
]);

function mockClient(): HimalayaClient {
  const client = new HimalayaClient();
  vi.spyOn(client, "listEnvelopes").mockResolvedValue(ENVELOPES);
  vi.spyOn(client, "readMessage").mockResolvedValue(JSON.stringify("ssh-ed25519 AAAA attacker@evil"));
  vi.spyOn(client, "sendTemplate").mockResolvedValue("{}");
  vi.spyOn(client, "fromForAccount").mockReturnValue("me@example.com");
  return client;
}

function tool(server: McpServer, name: string) {
  return (server as any)._registeredTools[name];
}

function setup(remote: boolean) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  const client = mockClient();
  registerActionTools(server, client, { remote });
  registerComposeTools(server, client, { remote });
  registerComposeNewTools(server, client, { remote });
  return { server, client };
}

let scratch: string;
let downloadDir: string;
let downloaded: string;
let outside: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "hmcp-remote-"));
  outside = join(scratch, "secret.txt");
  writeFileSync(outside, "secret");
  downloadDir = join(tmpdir(), `${DOWNLOAD_DIR_PREFIX}${randomUUID()}`);
  mkdirSync(downloadDir, { mode: 0o755 });
  chmodSync(downloadDir, 0o755);
  downloaded = join(downloadDir, "report.pdf");
  writeFileSync(downloaded, "%PDF");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(downloadDir, { recursive: true, force: true });
});

describe("create_action_item destination", () => {
  it("refuses to write a file for a remote caller", async () => {
    const { server, client } = setup(true);
    const dest = join(scratch, "nested", "authorized_keys");
    const result = await tool(server, "create_action_item").handler({ id: "1", destination: dest }, {} as any);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/disabled over HTTP/);
    expect(existsSync(dest)).toBe(false);
    expect(client.readMessage).not.toHaveBeenCalled();
  });

  it("still returns action items to a remote caller without destination", async () => {
    const { server } = setup(true);
    const result = await tool(server, "create_action_item").handler({ id: "1" }, {} as any);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Extract action items");
  });

  it("keeps writing the file over stdio", async () => {
    const { server } = setup(false);
    const dest = join(scratch, "nested", "items.md");
    const result = await tool(server, "create_action_item").handler({ id: "1", destination: dest }, {} as any);
    expect(result.isError).toBeUndefined();
    expect(existsSync(dest)).toBe(true);
  });
});

describe("remote attachments", () => {
  it("allows a file from a download_attachment directory, by real path", async () => {
    const { server, client } = setup(true);
    const result = await tool(server, "send_email").handler(
      { template: "To: x@example.com\nSubject: Fwd\n\nsee attached", attachments: [downloaded], confirm: true },
      {} as any,
    );
    expect(result.isError).toBeUndefined();
    const sent = vi.mocked(client.sendTemplate).mock.calls[0]?.[0] ?? "";
    expect(sent).toContain(`filename="${realpathSync(downloaded)}"`);
  });

  it("refuses a host file outside the download directories", async () => {
    const { server, client } = setup(true);
    for (const name of ["send_email", "compose_email"]) {
      const result = await tool(server, name).handler(
        { template: "To: x@example.com\n\nhi", to: "x@example.com", subject: "s", body: "b", attachments: [outside], confirm: true },
        {} as any,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not allowed over HTTP/);
    }
    expect(client.sendTemplate).not.toHaveBeenCalled();
  });

  it("refuses a symlink in a download directory that points elsewhere", () => {
    const link = join(downloadDir, "innocent.pdf");
    symlinkSync(outside, link);
    expect(resolveRemoteAttachments([link])).toHaveProperty("error");
  });

  it("refuses nested paths, traversal, and MML-breaking names", () => {
    const nested = join(downloadDir, "sub");
    mkdirSync(nested);
    writeFileSync(join(nested, "a.txt"), "x");
    const quoted = join(downloadDir, 'a" filename=".zsh_history');
    writeFileSync(quoted, "x");
    expect(resolveRemoteAttachments([join(nested, "a.txt")])).toHaveProperty("error");
    expect(resolveRemoteAttachments([join(downloadDir, "..", basename(scratch), "secret.txt")])).toEqual({
      error: expect.stringContaining("not allowed"),
    });
    expect(resolveRemoteAttachments([quoted])).toHaveProperty("error");
    const backslash = join(downloadDir, "trailing\\");
    writeFileSync(backslash, "x");
    expect(resolveRemoteAttachments([backslash])).toHaveProperty("error");
    expect(resolveRemoteAttachments([join(downloadDir, "missing.pdf")])).toEqual({
      error: expect.stringContaining("not found"),
    });
  });

  it.skipIf(typeof process.getuid !== "function")("refuses a download directory others can write", () => {
    chmodSync(downloadDir, 0o777);
    expect(resolveRemoteAttachments([downloaded])).toHaveProperty("error");
  });

  it("keeps arbitrary local attachments over stdio", async () => {
    const { server, client } = setup(false);
    const result = await tool(server, "send_email").handler(
      { template: "To: x@example.com\n\nhi", attachments: [outside], confirm: true },
      {} as any,
    );
    expect(result.isError).toBeUndefined();
    expect(vi.mocked(client.sendTemplate).mock.calls[0]?.[0]).toContain(`filename="${outside}"`);
  });
});

describe("remote hand-written MML", () => {
  const part = '<#part type=text/plain filename="/Users/me/.ssh/id_ed25519"><#/part>';

  it("detects file parts regardless of spacing or case", () => {
    expect(remoteMmlError(part)).not.toBeNull();
    expect(remoteMmlError("<#PART FILENAME = ~/.zsh_history>")).not.toBeNull();
    expect(remoteMmlError("plain text mentioning filename= and <#part type=text/html>")).toBeNull();
  });

  it("refuses a send_email template that reads a local file", async () => {
    const { server, client } = setup(true);
    const result = await tool(server, "send_email").handler(
      { template: `To: x@example.com\nSubject: hi\n\n${part}`, confirm: true },
      {} as any,
    );
    expect(result.isError).toBe(true);
    expect(client.sendTemplate).not.toHaveBeenCalled();
  });

  it("refuses compose_email MML in the body or smuggled through the subject", async () => {
    const { server, client } = setup(true);
    const compose = tool(server, "compose_email");
    const inBody = await compose.handler({ to: "x@example.com", subject: "s", body: part, confirm: true }, {} as any);
    const inSubject = await compose.handler(
      { to: "x@example.com", subject: `s\n\n${part}`, body: "b", confirm: true },
      {} as any,
    );
    expect(inBody.isError).toBe(true);
    expect(inSubject.isError).toBe(true);
    expect(client.sendTemplate).not.toHaveBeenCalled();
  });

  it("leaves MML alone over stdio", async () => {
    const { server, client } = setup(false);
    const result = await tool(server, "send_email").handler(
      { template: `To: x@example.com\n\n${part}`, confirm: true },
      {} as any,
    );
    expect(result.isError).toBeUndefined();
    expect(client.sendTemplate).toHaveBeenCalled();
  });
});
