/**
 * MCP tool for composing new emails (not replies).
 *
 * Uses the same two-phase safety gate as send_email:
 * - Without confirm=true: returns a preview
 * - With confirm=true: actually sends via himalaya
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HimalayaClient } from "../himalaya/client.js";
import { envelopeError } from "./_envelope.js";
import { validateAttachmentPaths, buildAttachmentMml, escapeMml } from "./_attachments.js";
import { remoteMmlError, resolveRemoteAttachments, type ToolAccessOptions } from "./_remote.js";

/** Build an MML email template from parameters. */
function buildTemplate(
  to: string,
  subject: string,
  body: string,
  cc?: string,
  bcc?: string,
  from?: string,
  attachments?: string[],
): string {
  const headers: string[] = [];
  if (from) headers.push(`From: ${from}`);
  headers.push(`To: ${to}`);
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  headers.push(`Subject: ${subject}`);
  // The body is plain text: escape MML so a tag pasted from another email
  // (e.g. when forwarding) is sent as text, not compiled into a file attachment.
  let result = headers.join("\n") + "\n\n" + escapeMml(body);
  if (attachments?.length) {
    result += "\n\n" + buildAttachmentMml(attachments);
  }
  return result;
}

export function registerComposeNewTools(
  server: McpServer,
  client: HimalayaClient,
  options: ToolAccessOptions = {},
) {
  server.registerTool("compose_email", {
    description: "Compose and send a new email (not a reply). SAFETY: requires confirm=true to actually send. Without confirm, returns a preview for user review.",
    inputSchema: {
      to: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body text"),
      cc: z.string().optional().describe("CC recipient(s)"),
      bcc: z.string().optional().describe("BCC recipient(s)"),
      attachments: z.array(z.string()).optional().describe("Local file paths to attach (e.g. [\"/tmp/report.pdf\"])"),
      confirm: z.boolean().optional().describe("Set to true to actually send. Without this, only shows a preview."),
      account: z.string().optional().describe("Account name (uses default if omitted)"),
    },
  }, async (args) => {
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!EMAIL_RE.test(args.to)) {
      return {
        content: [{
          type: "text" as const,
          text: `Invalid email address "${args.to}". Must contain @.`,
        }],
        isError: true,
      };
    }

    // A newline in a header value would end the headers early and let the
    // rest of the value through as unescaped MML body.
    for (const [field, value] of [["subject", args.subject], ["cc", args.cc], ["bcc", args.bcc]] as const) {
      if (value && /[\r\n]/.test(value)) {
        return {
          content: [{ type: "text" as const, text: `Invalid ${field}: must not contain line breaks.` }],
          isError: true,
        };
      }
    }

    const from = client.fromForAccount(args.account);
    if (!from) {
      return {
        content: [{
          type: "text" as const,
          text: "No sender address configured. Set HIMALAYA_FROM env var, or add `email = \"you@example.com\"` to your default account in ~/.config/himalaya/config.toml.",
        }],
        isError: true,
      };
    }

    let attachments = args.attachments;
    if (options.remote) {
      // Check every caller-supplied field: a newline in subject or cc can
      // carry MML into the body as easily as body itself.
      const mmlErr = remoteMmlError(buildTemplate(args.to, args.subject, args.body, args.cc, args.bcc, from));
      if (mmlErr) {
        return { content: [{ type: "text" as const, text: mmlErr }], isError: true };
      }
      if (attachments?.length) {
        const resolved = resolveRemoteAttachments(attachments);
        if ("error" in resolved) {
          return { content: [{ type: "text" as const, text: resolved.error }], isError: true };
        }
        attachments = resolved.paths;
      }
    }

    // Validate attachment paths before building the template
    if (attachments?.length) {
      const err = validateAttachmentPaths(attachments);
      if (err) {
        return {
          content: [{ type: "text" as const, text: err }],
          isError: true,
        };
      }
    }

    const template = buildTemplate(args.to, args.subject, args.body, args.cc, args.bcc, from, attachments);

    // Safety gate: without confirm=true, just show preview
    if (!args.confirm) {
      return {
        content: [{
          type: "text" as const,
          text: [
            "--- EMAIL PREVIEW (not sent) ---",
            "",
            template,
            "",
            "--- END PREVIEW ---",
            "",
            "This email has NOT been sent. To send, call compose_email again with confirm=true.",
            "Ask the user to confirm before sending.",
          ].join("\n"),
        }],
      };
    }

    // Actually send
    try {
      await client.sendTemplate(template, args.account);
      return {
        content: [{
          type: "text" as const,
          text: `Email sent successfully to ${args.to}.`,
        }],
      };
    } catch (err) {
      return envelopeError(err);
    }
  });
}
