/**
 * MCP tools for managing emails: flagging, moving, and deleting.
 *
 * delete_email uses the same two-phase safety gate as delete_folder:
 * without confirm=true it only returns a preview warning.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HimalayaClient } from "../himalaya/client.js";
import { envelopeError } from "./_envelope.js";
import { getTrashFolder } from "../himalaya/trash.js";

/** Mailbox names that are the trash, where delete expunges instead of moving. */
const TRASH_NAME_RE = /(^|\/)(trash|bin|deleted items|deleted messages)$/i;

export function registerManageTools(server: McpServer, client: HimalayaClient) {
  server.registerTool("flag_email", {
    description: "Add or remove flags on an email. Flags: Seen, Flagged, Answered, Draft. Use 'add' to set flags, 'remove' to clear them. Pass folder as the mailbox the message was listed from; it is sent to himalaya with the id. Deleted is not a himalaya v2 flag — use delete_email to trash a message.",
    inputSchema: {
      id: z.string().describe("Email message ID"),
      flags: z.array(z.string()).describe("Flags to add/remove (e.g. ['Seen', 'Flagged'])"),
      action: z.enum(["add", "remove"]).describe("Whether to add or remove the flags"),
      folder: z.string().optional().describe("Folder name (default: INBOX)"),
      account: z.string().optional().describe("Account name (uses default if omitted)"),
    },
  }, async (args) => {
    try {
      await client.flagMessage(args.id, args.flags, args.action, args.folder, args.account);
      const verb = args.action === "add" ? "Added" : "Removed";
      return {
        content: [{
          type: "text" as const,
          text: `${verb} flags [${args.flags.join(", ")}] on email ${args.id}`,
        }],
      };
    } catch (err) {
      return envelopeError(err);
    }
  });

  server.registerTool("move_email", {
    description: "Move an email to a different folder. Common targets: Archive, Trash, Spam, Sent, Drafts. target_folder is the destination and is passed to himalaya (v2: --to). folder is the mailbox the message is in now (v2: --from) and is passed even when it is INBOX.",
    inputSchema: {
      id: z.string().describe("Email message ID"),
      target_folder: z.string().describe("Destination folder name (e.g. 'Archive', 'Trash')"),
      folder: z.string().optional().describe("Source mailbox that currently holds the message (default: INBOX). Always passed to himalaya."),
      account: z.string().optional().describe("Account name (uses default if omitted)"),
    },
  }, async (args) => {
    try {
      await client.moveMessage(args.id, args.target_folder, args.folder, args.account);
      return {
        content: [{
          type: "text" as const,
          text: `Moved email ${args.id} to ${args.target_folder}`,
        }],
      };
    } catch (err) {
      return envelopeError(err);
    }
  });

  server.registerTool("delete_email", {
    description: "Trash an email. SAFETY: requires confirm=true to actually delete. Without confirm, returns a preview warning. Moves the message to the trash mailbox, or permanently expunges it when it is already in trash. folder is the mailbox that currently holds the message (not the trash folder) and is passed to himalaya with the id. On himalaya 2.0, which has no message delete command, this moves the message to the provider trash folder instead. Always show the user the preview and get their approval before calling with confirm=true.",
    inputSchema: {
      id: z.string().describe("Email message ID"),
      folder: z.string().optional().describe("Mailbox that currently holds the message (default: INBOX). Always passed to himalaya."),
      confirm: z.boolean().optional().describe("Set to true to actually delete. Without this, only shows a preview warning."),
      account: z.string().optional().describe("Account name (uses default if omitted)"),
    },
  }, async (args) => {
    // Safety gate: without confirm=true, just show warning
    if (!args.confirm) {
      const mailbox = args.folder || "INBOX";
      const inTrash = TRASH_NAME_RE.test(mailbox) || mailbox === getTrashFolder(args.account);
      return {
        content: [{
          type: "text" as const,
          text: [
            "--- DELETE EMAIL PREVIEW ---",
            "",
            `Email to delete: ${args.id}`,
            `Mailbox: ${mailbox}`,
            "",
            inTrash
              ? "WARNING: This mailbox is the trash. Deleting here permanently expunges the email. It cannot be recovered."
              : "The email moves to the trash mailbox. If this mailbox is already the trash, it is permanently expunged instead.",
            "",
            "--- END PREVIEW ---",
            "",
            "This email has NOT been deleted. To delete, call delete_email again with confirm=true.",
            "Ask the user to confirm before deleting.",
          ].join("\n"),
        }],
      };
    }

    try {
      await client.deleteMessage(args.id, args.folder, args.account);
      const from = args.folder ? ` from ${args.folder}` : "";
      return {
        content: [{
          type: "text" as const,
          text: `Deleted email ${args.id}${from}`,
        }],
      };
    } catch (err) {
      return envelopeError(err);
    }
  });
}
