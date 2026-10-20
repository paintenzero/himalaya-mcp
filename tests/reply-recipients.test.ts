import { describe, expect, it } from "vitest";
import { replyAllCc } from "../src/himalaya/reply-recipients.js";

function message(headers: unknown[]): string {
  return JSON.stringify({
    text_body: [0],
    html_body: [],
    attachments: [],
    parts: [{ headers, body: { Text: "hello" } }],
  });
}

function addresses(name: string, list: Array<{ name: string | null; address: string }>) {
  return { name, value: { Address: { List: list } } };
}

describe("replyAllCc", () => {
  const raw = message([
    addresses("from", [{ name: "Ada", address: "ada@example.com" }]),
    addresses("to", [
      { name: "Me", address: "me@example.com" },
      { name: "Bea", address: "bea@example.com" },
    ]),
    addresses("cc", [
      { name: "Lifanov", address: "lifanov@example.com" },
      { name: "Basil", address: "basil@example.com" },
      { name: "Ada", address: "ada@example.com" },
    ]),
  ]);

  it("copies source To and Cc, skipping the sender and the account", () => {
    expect(replyAllCc(raw, "me@example.com")).toEqual([
      "bea@example.com",
      "lifanov@example.com",
      "basil@example.com",
    ]);
  });

  it("treats Reply-To as the person already in To", () => {
    // himalaya --all keeps Reply-To (or From) in To and copies only source To and Cc.
    // From is not added again unless that address is also in To or Cc.
    const withReplyTo = message([
      addresses("reply_to", [{ name: null, address: "list@example.com" }]),
      addresses("from", [{ name: "Ada", address: "ada@example.com" }]),
      addresses("to", [{ name: "Me", address: "me@example.com" }]),
      addresses("cc", [{ name: "Basil", address: "basil@example.com" }]),
    ]);
    expect(replyAllCc(withReplyTo, "me@example.com")).toEqual([
      "basil@example.com",
    ]);
  });

  it("rejects a non-JSON body", () => {
    expect(() => replyAllCc("not json", "me@example.com")).toThrow(/not JSON/);
  });
});
