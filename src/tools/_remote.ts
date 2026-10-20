/**
 * Host-filesystem limits for tools served over the network.
 *
 * Over stdio the caller is the user's own Claude session. Over HTTP the
 * caller is whoever holds the bearer token, often an agent reading untrusted
 * email with no human approving each call. In that mode tools must not write
 * to arbitrary host paths or attach arbitrary host files to outgoing mail.
 */

import { lstatSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

export interface ToolAccessOptions {
  /** True when tools are served to a network client (`himalaya-mcp serve`). */
  remote?: boolean;
}

/** Directory prefix download_attachment uses under the OS temp dir. */
export const DOWNLOAD_DIR_PREFIX = "himalaya-mcp-";

/**
 * MML tag carrying a `filename=` attribute. himalaya compiles these into
 * attachments read from the local disk when the template is sent.
 */
const MML_FILE_PART = /<#[^>]*\bfilename\s*=/i;

export const REMOTE_FILE_WRITE_ERROR =
  "Saving to a file is disabled over HTTP. The action items are returned in the response instead.";

/** Reject caller-written MML that would make himalaya read a local file. */
export function remoteMmlError(template: string): string | null {
  if (MML_FILE_PART.test(template)) {
    return "MML parts with filename= are disabled over HTTP. Pass files with `attachments` instead (only files from download_attachment are allowed).";
  }
  return null;
}

/**
 * Resolve remote attachment paths. Only regular files inside a
 * download_attachment directory owned by this user are allowed, so a
 * network caller can forward a downloaded attachment but cannot mail out
 * other host files. Returns real paths so a later symlink swap cannot
 * redirect the send.
 */
export function resolveRemoteAttachments(paths: string[]): { paths: string[] } | { error: string } {
  const root = realpathSync(tmpdir());
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const resolved: string[] = [];

  for (const p of paths) {
    const denied = { error: `Attachment not allowed over HTTP: "${p}". Only files from download_attachment can be attached.` };
    let real: string;
    try {
      real = realpathSync(p);
    } catch {
      return { error: `Attachment not found: "${p}"` };
    }

    // Attachment names come from the sender; a quote, a backslash (MML's
    // escape character) or a bracket would break out of filename="...".
    if (/["\\<>\r\n]/.test(real)) return denied;

    const rel = relative(root, real);
    const parts = rel.split(sep);
    if (isAbsolute(rel) || parts.length !== 2 || parts[0] === ".." || !parts[0]?.startsWith(DOWNLOAD_DIR_PREFIX)) {
      return denied;
    }

    const dir = lstatSync(join(root, parts[0]));
    const file = statSync(real);
    if (!dir.isDirectory() || !file.isFile()) return denied;
    if (uid !== undefined && (dir.uid !== uid || file.uid !== uid || (dir.mode & 0o022) !== 0)) {
      return denied;
    }
    resolved.push(real);
  }
  return { paths: resolved };
}
