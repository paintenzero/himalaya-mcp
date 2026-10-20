/**
 * MCP server assembly shared by the stdio entry and the HTTP listener.
 *
 * One HimalayaClient is reused across requests. Each MCP session gets its
 * own McpServer, because a server instance can only bind one transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HimalayaClient } from "./himalaya/client.js";
import { loadConfig } from "./config.js";
import { registerClipboardTools } from "./adapters/clipboard.js";
import { registerInboxTools } from "./tools/inbox.js";
import { registerReadTools } from "./tools/read.js";
import { registerManageTools } from "./tools/manage.js";
import { registerActionTools } from "./tools/actions.js";
import { registerResources } from "./resources/index.js";
import { registerTriagePrompt } from "./prompts/triage.js";
import { registerSummarizePrompt } from "./prompts/summarize.js";
import { registerDigestPrompt } from "./prompts/digest.js";
import { registerComposeTools } from "./tools/compose.js";
import { registerComposeNewTools } from "./tools/compose-new.js";
import { registerFolderTools } from "./tools/folders.js";
import { registerAttachmentTools } from "./tools/attachments.js";
import { registerCalendarTools } from "./tools/calendar.js";
import { registerThreadTools } from "./tools/threads.js";
import { registerHealthTools } from "./tools/health.js";
import { registerUnreadTools } from "./tools/unread.js";
import { registerReadRawTools } from "./tools/read-raw.js";
import { registerRenderTools } from "./tools/render.js";
import { registerStarredTools } from "./tools/list-starred.js";
import { registerReminderTools } from "./tools/reminders.js";
import { registerSnoozeTools } from "./tools/snooze.js";
import { registerWeeklyDigestPrompt } from "./prompts/weekly-digest.js";
import { registerReplyPrompt } from "./prompts/reply.js";
import { registerMorningPrompt } from "./prompts/morning.js";
import { registerInboxCheckPrompt } from "./prompts/inbox-check.js";
import type { ToolAccessOptions } from "./tools/_remote.js";

export const VERSION = "2.1.2";
export const NAME = "himalaya-mcp";
export const TOOL_COUNT = 30;

export interface McpServerOptions extends ToolAccessOptions {
  client?: HimalayaClient;
}

export function wireMcpServer(
  server: McpServer,
  client: HimalayaClient,
  options: ToolAccessOptions = {},
): void {
  registerInboxTools(server, client);
  registerReadTools(server, client);
  registerManageTools(server, client);
  registerActionTools(server, client, options);
  registerComposeTools(server, client, options);
  registerComposeNewTools(server, client, options);
  registerFolderTools(server, client);
  registerAttachmentTools(server, client);
  registerCalendarTools(server, client);
  registerThreadTools(server, client);
  registerHealthTools(server, client);
  registerClipboardTools(server);
  registerUnreadTools(server, client);
  registerReadRawTools(server, client);
  registerRenderTools(server, client);
  registerStarredTools(server, client);
  registerReminderTools(server);
  registerSnoozeTools(server);

  registerResources(server, client);

  registerTriagePrompt(server);
  registerSummarizePrompt(server);
  registerDigestPrompt(server);
  registerReplyPrompt(server);
  registerMorningPrompt(server);
  registerInboxCheckPrompt(server);
  registerWeeklyDigestPrompt(server);
}

/**
 * Build a fresh server bound to a shared himalaya client.
 * Pass `remote: true` for network listeners: tools then refuse arbitrary
 * host-file writes and attachments (see tools/_remote.ts).
 */
export function createMcpServerFactory(options: McpServerOptions = {}): () => McpServer {
  const { client = new HimalayaClient(loadConfig()), ...access } = options;
  return () => {
    const server = new McpServer({ name: NAME, version: VERSION });
    wireMcpServer(server, client, access);
    return server;
  };
}

/** One server for the long-lived stdio process. */
export function createMcpServer(): McpServer {
  return createMcpServerFactory()();
}
