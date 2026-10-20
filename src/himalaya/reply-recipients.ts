/**
 * Recipients for himalaya v2 reply-all.
 *
 * v2.2 `message reply` has no `--all`. It addresses Reply-To or From, and an
 * explicit `--cc` replaces the Cc it would otherwise leave empty. Reply-all
 * puts the source To and Cc on that flag, once each, skipping the account
 * address and anyone already in To.
 */

export interface ReplyAddress {
  name: string | null;
  address: string;
}

export function replyAllCc(rawMessage: string, selfEmail?: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    throw new Error("Cannot read recipients for reply-all: message was not JSON");
  }

  const replyTo = headerAddresses(parsed, ["reply_to", "reply-to"]);
  const from = headerAddresses(parsed, ["from", "sender"]);
  const to = headerAddresses(parsed, ["to"]);
  const cc = headerAddresses(parsed, ["cc"]);
  const primary = (replyTo.length > 0 ? replyTo : from).map((addr) => addr.address.toLowerCase());
  const skip = new Set(primary);
  if (selfEmail) skip.add(selfEmail.toLowerCase());

  const seen = new Set<string>();
  const result: string[] = [];
  for (const addr of [...to, ...cc]) {
    const key = addr.address.toLowerCase();
    if (skip.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(addr.address);
  }
  return result;
}

function headerAddresses(message: unknown, names: string[]): ReplyAddress[] {
  const headers = rootHeaders(message);
  const want = new Set(names);
  const found: ReplyAddress[] = [];
  for (const header of headers) {
    if (!header || typeof header !== "object") continue;
    const record = header as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.toLowerCase() : "";
    if (!want.has(name)) continue;
    collectAddresses(record.value, found);
  }
  return found;
}

function rootHeaders(message: unknown): unknown[] {
  if (!message || typeof message !== "object") return [];
  const parts = (message as { parts?: unknown }).parts;
  if (!Array.isArray(parts) || parts.length === 0) return [];
  const first = parts[0];
  if (!first || typeof first !== "object") return [];
  const headers = (first as { headers?: unknown }).headers;
  return Array.isArray(headers) ? headers : [];
}

function collectAddresses(value: unknown, out: ReplyAddress[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectAddresses(item, out);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.address === "string" && record.address.includes("@")) {
    out.push({
      name: typeof record.name === "string" ? record.name : null,
      address: record.address,
    });
  }
  for (const child of Object.values(record)) collectAddresses(child, out);
}
