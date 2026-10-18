/**
 * Shared attachment utilities for MML template construction.
 * Used by compose_email and send_email tools.
 */

import { existsSync } from "node:fs";
import { basename, extname } from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

/** Return the MIME type for a file path based on its extension. */
export function mimeTypeForPath(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Characters that can break out of the quoted MML `filename="..."` attribute.
 * himalaya's MML parser treats `\` as an escape inside quoted values, so a
 * name ending in `\` swallows the closing quote just like a `"` would.
 * download_attachment saves files under sender-chosen names, so these paths
 * are not always picked by the user.
 */
const UNSAFE_PATH_CHARS = /["\\<>\r\n]/;

/** MML tag openers, and the `<#!` escapes himalaya turns back into plain text. */
const MML_ESCAPES: [string, string][] = [
  ["<#part", "<#!part"],
  ["<#/part>", "<#!/part>"],
  ["<#multipart", "<#!multipart"],
  ["<#/multipart>", "<#!/multipart>"],
];

/**
 * Escape MML markup so himalaya sends it as literal text instead of
 * compiling it. Without this, a `<#part filename=/path>` tag copied from
 * an email body would make himalaya read and attach that local file.
 */
export function escapeMml(text: string): string {
  let out = text;
  for (const [tag, escaped] of MML_ESCAPES) out = out.split(tag).join(escaped);
  return out;
}

/**
 * Return an error if a caller-written MML template contains a part that
 * reads a local file. Files must go through the `attachments` parameter so
 * they show up as an explicit tool argument instead of hiding in the body.
 *
 * Deliberately coarse: any `filename=` after the first `<#part` is rejected,
 * because quoted MML values may contain `>` or `<#/part>` and a tag-aware
 * check would have to match himalaya's parser exactly.
 */
export function templateFilePartError(template: string): string | null {
  const start = template.indexOf("<#part");
  if (start !== -1 && /filename\s*=/i.test(template.slice(start))) {
    return "The template contains an MML part with filename=, which would attach a local file. Remove it and pass files with `attachments` instead.";
  }
  return null;
}

/**
 * Validate that all attachment paths exist on disk and are safe to embed
 * in MML. Returns an error message string for the first bad path, null if
 * all are OK.
 */
export function validateAttachmentPaths(paths: string[]): string | null {
  for (const p of paths) {
    if (UNSAFE_PATH_CHARS.test(p)) {
      return `Attachment path contains characters not allowed in MML (", \\, <, > or a newline): ${JSON.stringify(p)}. Rename or copy the file first.`;
    }
    if (!existsSync(p)) {
      return `Attachment not found: "${p}"`;
    }
  }
  return null;
}

/**
 * Build MML <#part> sections for a list of file paths.
 * Appended after the email body — himalaya's MML parser resolves the
 * filename attributes into real MIME attachments when sending.
 */
export function buildAttachmentMml(paths: string[]): string {
  return paths
    .map((p) => {
      if (UNSAFE_PATH_CHARS.test(p)) {
        throw new Error(`Unsafe attachment path: ${JSON.stringify(p)}`);
      }
      const name = basename(p);
      const type = mimeTypeForPath(p);
      return `<#part type=${type} name="${name}" filename="${p}" disposition=attachment>\n<#/part>`;
    })
    .join("\n");
}
