/**
 * read_email_raw MCP tool.
 *
 * Returns the raw MIME source of an email using himalaya's
 * `message export --full` command, which exports the raw,
 * unedited message as a .eml file.
 */

import { z } from "zod/v4";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HimalayaClient } from "../himalaya/client.js";
import { envelopeError } from "./_envelope.js";

const execFileAsync = promisify(execFile);

export function registerReadRawTools(server: McpServer, client: HimalayaClient) {
  server.registerTool("read_email_raw", {
    description: "Read the raw MIME source of an email. Returns the full, unedited message including all headers. Useful for debugging, email forensics, and exporting to .eml format. Pass folder as the mailbox the message was listed from; it is sent to himalaya with the id.",
    inputSchema: {
      id: z.string().describe("Email message ID"),
      folder: z.string().optional().describe("Mailbox that holds the message (default: INBOX). Always passed to himalaya."),
      account: z.string().optional().describe("Account name (uses default if omitted)"),
    },
  }, async (args) => {
    const tmpDir = mkdtempSync(join(tmpdir(), "himalaya-mcp-raw-"));
    const emlPath = join(tmpDir, `${args.id}.eml`);
    try {
      const version = await client.resolveVersion();
      if (version.major >= 2) {
        // v2 removed `message export`. `message read --raw` writes the RFC 5322
        // bytes, and the mailbox has to be passed or the id is read from inbox.
        const raw = await client.readMessageRaw(args.id, args.folder, args.account);
        return {
          content: [{ type: "text" as const, text: raw }],
        };
      }

      const binary = client.binary;

      // v1: export --full --destination <path> --folder <mailbox> <id>
      const cmdArgs: string[] = ["message", "export", "--full", "--destination", emlPath];
      const folder = args.folder || "INBOX";
      if (folder.startsWith("-")) {
        throw new Error(`folder value "${folder}" looks like a flag (starts with "-"). Refusing to pass it to himalaya.`);
      }
      cmdArgs.push("--folder", folder);
      const account = args.account || client.account || "";
      if (account) {
        if (account.startsWith("-")) {
          throw new Error(`account value "${account}" looks like a flag (starts with "-"). Refusing to pass it to himalaya.`);
        }
        cmdArgs.push("--account", account);
      }
      if (args.id.startsWith("-")) {
        throw new Error(`id value "${args.id}" looks like a flag (starts with "-"). Refusing to pass it to himalaya.`);
      }
      cmdArgs.push(args.id);

      await execFileAsync(binary, cmdArgs, { timeout: 30_000 });

      const raw = readFileSync(emlPath, "utf-8");
      return {
        content: [{ type: "text" as const, text: raw }],
      };
    } catch (err) {
      return envelopeError(err);
    } finally {
      try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore cleanup errors */ }
    }
  });
}
