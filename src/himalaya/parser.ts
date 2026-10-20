/**
 * JSON response parser for himalaya CLI output.
 * Converts raw stdout strings into typed objects.
 */

import type {
  Envelope,
  Folder,
  Account,
  Address,
  MessageBody,
  CommandOutput,
  V2Envelope,
  V2Address,
  V2Mailbox,
} from "./types.js";

/**
 * Parse a JSON response from himalaya, returning a typed result.
 * Handles empty responses, malformed JSON, and error strings.
 */
export function parse<T>(raw: string): CommandOutput<T> {
  const trimmed = raw.trim();

  if (!trimmed) {
    return { ok: false, error: "Empty response from himalaya", code: "EMPTY" };
  }

  try {
    const data = JSON.parse(trimmed) as T;
    return { ok: true, data };
  } catch {
    // himalaya might return an error string instead of JSON
    return {
      ok: false,
      error: `Failed to parse himalaya output: ${trimmed.slice(0, 200)}`,
      code: "PARSE_ERROR",
    };
  }
}

/**
 * Unwrap a himalaya list response into a bare array, reporting which wire
 * shape was matched so callers can pick the right normalization.
 *
 * himalaya v1 returns bare arrays (`[...]`), while v2 wraps them in a named
 * object (`{"mailboxes":[...]}`, `{"envelopes":[...]}`). The matched shape is
 * authoritative: `"array"` means the elements are canonical v1 shapes, `"key"`
 * means they are v2 wire shapes, and `"none"` means the response had neither
 * shape (callers should fail loud rather than degrade to an empty list).
 */
export type ListUnwrap<T> = { matched: "array" | "key" | "none"; data: T[] };

export function unwrapList<T>(data: unknown, key: string): ListUnwrap<T> {
  if (Array.isArray(data)) return { matched: "array", data: data as T[] };
  if (data !== null && typeof data === "object") {
    const wrapped = (data as Record<string, unknown>)[key];
    if (Array.isArray(wrapped)) return { matched: "key", data: wrapped as T[] };
  }
  return { matched: "none", data: [] };
}

/** Map a v2 address (array of {name, email}) to the canonical single Address. */
function firstAddress(list: V2Address[]): Address {
  const first = list[0];
  return first ? { name: first.name, addr: first.email } : { name: null, addr: "" };
}

/**
 * Normalize a v2 envelope object to the canonical v1 Envelope shape.
 * Only called on the v2 wire shape (`{envelopes:[...]}`), so `from`/`to` are
 * arrays, `flags` are {raw, iana} objects, and attachment is kebab-case.
 */
function normalizeEnvelope(e: V2Envelope): Envelope {
  return {
    id: e.id,
    flags: e.flags.map((f) => f.raw.replace(/^\\/, "")),
    subject: e.subject,
    from: firstAddress(e.from),
    to: firstAddress(e.to),
    date: e.date,
    has_attachment: Boolean(e["has-attachment"]),
  };
}

/**
 * Normalize a v2 mailbox object to the canonical Folder shape.
 * v2 mailbox objects carry id/name/total/unread but no `desc`.
 */
function normalizeFolder(f: V2Mailbox): Folder {
  return { name: f.name, desc: "" };
}

/**
 * Parse envelope list response (v1 bare array or v2 {"envelopes":[...]}).
 * Fails loud with `parse_error` when the response has neither shape rather
 * than silently reporting an empty inbox.
 */
export function parseEnvelopes(raw: string): CommandOutput<Envelope[]> {
  const result = parse<unknown>(raw);
  if (!result.ok) return result;
  const { matched, data } = unwrapList<Envelope | V2Envelope>(result.data, "envelopes");
  if (matched === "none") {
    return {
      ok: false,
      error: "Unexpected envelope list response (expected an array or {envelopes:[...]})",
      code: "PARSE_ERROR",
    };
  }
  const list = matched === "array" ? (data as Envelope[]) : (data as V2Envelope[]).map(normalizeEnvelope);
  return { ok: true, data: list };
}

/**
 * Parse folder list response (v1 bare array or v2 {"mailboxes":[...]}).
 * Fails loud with `parse_error` when the response has neither shape rather
 * than silently reporting an empty folder list.
 */
export function parseFolders(raw: string): CommandOutput<Folder[]> {
  const result = parse<unknown>(raw);
  if (!result.ok) return result;
  const { matched, data } = unwrapList<Folder | V2Mailbox>(result.data, "mailboxes");
  if (matched === "none") {
    return {
      ok: false,
      error: "Unexpected folder list response (expected an array or {mailboxes:[...]})",
      code: "PARSE_ERROR",
    };
  }
  const list = matched === "array" ? (data as Folder[]) : (data as V2Mailbox[]).map(normalizeFolder);
  return { ok: true, data: list };
}

/** Parse account list response. */
export function parseAccounts(raw: string): CommandOutput<Account[]> {
  return parse<Account[]>(raw);
}

/** Format an envelope as a pipe-delimited line for LLM consumption. */
export function formatEnvelope(e: Envelope): string {
  const flags = e.flags.length > 0 ? ` [${e.flags.join(", ")}]` : "";
  const attachment = e.has_attachment ? " [attachment]" : "";
  return `${e.id} | ${e.date} | ${e.from.name || e.from.addr} | ${e.subject}${flags}${attachment}`;
}

/**
 * Parse a template response from `himalaya template reply --output json`.
 *
 * himalaya returns either a plain JSON string OR an object of the form
 * `{content: string, cursor: {row: number, col: number}}`.
 * Both forms are normalized to a plain string for downstream use.
 */
export function parseTemplate(raw: string): CommandOutput<string> {
  const trimmed = raw.trim();

  if (!trimmed) {
    return { ok: false, error: "Empty template response", code: "EMPTY" };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;

    if (typeof parsed === "string") {
      return { ok: true, data: parsed };
    }

    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "content" in parsed &&
      typeof (parsed as { content: unknown }).content === "string"
    ) {
      return { ok: true, data: (parsed as { content: string }).content };
    }

    // Unexpected shape — fall through to raw text
    return { ok: true, data: trimmed };
  } catch {
    return { ok: true, data: trimmed };
  }
}

/**
 * Parse a plain-text message body.
 *
 * himalaya v1 `message read --output json` returns a JSON string.
 * himalaya 2.2 `message read --json` returns mail-parser's message:
 * `text_body` and `html_body` are indexes into `parts`, and each part's
 * `body` is a tagged object (`Text`, `Html`, `Multipart`, `Message`).
 * A later himalaya puts the decoded text straight in `text_body`.
 * An HTML-only message has no `Text` part; the plain view is the tags
 * stripped from the HTML part.
 */
export function parseMessageBody(raw: string): CommandOutput<MessageBody> {
  const extracted = extractMessage(raw, "text");
  if (!extracted.ok) return extracted;
  return { ok: true, data: extracted.data };
}

/**
 * Parse an HTML message body from the same himalaya payload.
 * A raw HTML string (v1 `message export`) is returned unchanged.
 * A v2 message with no HTML part yields an empty string.
 */
export function parseMessageHtml(raw: string): CommandOutput<MessageBody> {
  return extractMessage(raw, "html");
}

function extractMessage(raw: string, kind: "text" | "html"): CommandOutput<MessageBody> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "Empty message body", code: "EMPTY" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: true, data: trimmed };
  }

  if (typeof parsed === "string") {
    return { ok: true, data: parsed };
  }

  const message = asRecord(parsed);
  if (!message) {
    return { ok: true, data: trimmed };
  }

  const directText = stringList(message.text_body);
  const directHtml = stringList(message.html_body);
  if (kind === "html" && directHtml) return { ok: true, data: directHtml.join("\n") };
  if (kind === "text" && directText) return { ok: true, data: directText.join("\n\n") };

  const parts = Array.isArray(message.parts) ? message.parts : [];
  if (parts.length === 0) {
    if (typeof message.error === "string") {
      return { ok: false, error: message.error.split("\n")[0] ?? message.error, code: "PARSE_ERROR" };
    }
    if (kind === "html") return { ok: true, data: directHtml?.join("\n") ?? "" };
    if (directHtml) return { ok: true, data: htmlToText(directHtml.join("\n")) };
    return { ok: true, data: trimmed };
  }

  if (kind === "html") {
    const html = bodiesFor(parts, indexList(message.html_body), "Html");
    return { ok: true, data: html.join("\n") };
  }

  const textIndexes = indexList(message.text_body);
  const htmlIndexes = indexList(message.html_body);
  const text = bodiesFor(parts, textIndexes, "Text");
  if (text.length > 0) return { ok: true, data: text.join("\n\n") };

  const html = bodiesFor(parts, htmlIndexes?.length ? htmlIndexes : textIndexes, "Html");
  if (html.length > 0) return { ok: true, data: htmlToText(html.join("\n")) };

  return { ok: true, data: "" };
}

/** Drop tags from an HTML-only part so read_email still returns text. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    // Last, so an escaped entity (`&amp;lt;`) stays literal text.
    .replace(/&amp;/gi, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/** A decoded body field. Number arrays are part indexes, not text. */
function stringList(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")) {
    return value;
  }
  return undefined;
}

/**
 * Part indexes for a body field. An empty list means the message has no
 * such body, so callers must not fall back to scanning every part (that
 * would return an attachment). Only a missing field scans all parts.
 */
function indexList(value: unknown): number[] | undefined {
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
    return value;
  }
  return undefined;
}

function bodiesFor(parts: unknown[], indexes: number[] | undefined, variant: "Text" | "Html"): string[] {
  const chosen = indexes ? indexes.map((index) => parts[index]).filter((part) => part !== undefined) : parts;
  const found: string[] = [];
  for (const part of chosen) collectBodies(part, variant, found);
  return found;
}

function collectBodies(part: unknown, variant: "Text" | "Html", found: string[]): void {
  const record = asRecord(part);
  const body = asRecord(record?.body);
  if (!body) return;

  const direct = body[variant];
  if (typeof direct === "string" && direct.length > 0) found.push(direct);

  if (Array.isArray(body.Multipart)) {
    for (const child of body.Multipart) collectBodies(child, variant, found);
  }

  const nested = asRecord(body.Message);
  if (nested && Array.isArray(nested.parts)) {
    for (const child of nested.parts) collectBodies(child, variant, found);
  }
}
