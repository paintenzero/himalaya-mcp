import { describe, it, expect, vi, beforeEach } from "vitest";
import { promisify } from "node:util";
import { HimalayaClient } from "../src/himalaya/client.js";

// Mock child_process (same pattern as client.test.ts)
vi.mock("node:child_process", async () => {
  const { promisify: realPromisify } = await import("node:util");
  const fn: any = vi.fn();
  const promisified = vi.fn();
  fn[realPromisify.custom] = promisified;
  return { execFile: fn };
});

import { execFile } from "node:child_process";

const mockExecFileAsync = (execFile as any)[promisify.custom] as ReturnType<typeof vi.fn>;

function setupMock(stdout: string, stderr = "", version = "himalaya v2.2.1 +imap +smtp") {
  mockExecFileAsync
    .mockResolvedValueOnce({ stdout: version, stderr: "" })
    .mockResolvedValue({ stdout, stderr });
}

function argvOf(call: unknown[]): string[] {
  return call[1] as string[];
}

describe("Manage tools — client methods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("flagMessage", () => {
    it("builds v2 flag add with --flag and the mailbox", async () => {
      setupMock("{}");
      const client = new HimalayaClient();
      await client.flagMessage("42", ["Seen", "Flagged"], "add");

      const argv = argvOf(mockExecFileAsync.mock.calls[1]);
      expect(argv).toEqual([
        "flag", "add", "--mailbox", "INBOX", "--flag", "seen", "--flag", "flagged", "--json", "42",
      ]);
    });

    it("builds v2 flag remove with --flag", async () => {
      setupMock("{}");
      const client = new HimalayaClient();
      await client.flagMessage("42", ["Flagged"], "remove");

      const argv = argvOf(mockExecFileAsync.mock.calls[1]);
      expect(argv).toEqual([
        "flag", "remove", "--mailbox", "INBOX", "--flag", "flagged", "--json", "42",
      ]);
    });

    it("passes the source mailbox on v2, including names that casefold to INBOX", async () => {
      setupMock("{}");
      const client = new HimalayaClient();
      await client.flagMessage("42", ["Seen"], "add", "Inbox");

      const argv = argvOf(mockExecFileAsync.mock.calls[1]);
      expect(argv).toContain("--mailbox");
      expect(argv[argv.indexOf("--mailbox") + 1]).toBe("Inbox");
    });

    it("passes folder when not INBOX", async () => {
      setupMock("{}");
      const client = new HimalayaClient();
      await client.flagMessage("42", ["Seen"], "add", "Sent Items");

      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "himalaya",
        expect.arrayContaining(["--mailbox", "Sent Items"]),
        expect.any(Object),
      );
    });

    it("keeps positional flags on himalaya v1", async () => {
      setupMock("{}", "", "himalaya 1.1.0");
      const client = new HimalayaClient();
      await client.flagMessage("42", ["Seen", "Flagged"], "add", "Sent");

      const argv = argvOf(mockExecFileAsync.mock.calls[1]);
      expect(argv).toEqual([
        "flag", "add", "42", "Seen", "Flagged", "--folder", "Sent", "--output", "json",
      ]);
    });

    it("rejects Deleted on himalaya v2", async () => {
      setupMock("{}");
      const client = new HimalayaClient();
      await expect(client.flagMessage("42", ["Deleted"], "add")).rejects.toThrow(/delete_email/);
    });

    it("passes account when specified", async () => {
      setupMock("{}");
      const client = new HimalayaClient();
      await client.flagMessage("42", ["Seen"], "add", undefined, "work");

      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "himalaya",
        expect.arrayContaining(["--account", "work"]),
        expect.any(Object),
      );
    });
  });

  describe("moveMessage", () => {
    it("passes the destination as --to and the source as --from on v2", async () => {
      setupMock("{}");
      const client = new HimalayaClient();
      await client.moveMessage("42", "Archive");

      const argv = argvOf(mockExecFileAsync.mock.calls[1]);
      expect(argv).toEqual([
        "message", "move", "--from", "INBOX", "--to", "Archive", "--json", "42",
      ]);
      expect(argv).not.toContain("--mailbox");
    });

    it("passes a non-inbox source as --from, not --mailbox", async () => {
      setupMock("{}");
      const client = new HimalayaClient();
      await client.moveMessage("42", "Trash", "Sent Items");

      const argv = argvOf(mockExecFileAsync.mock.calls[1]);
      expect(argv).toEqual([
        "message", "move", "--from", "Sent Items", "--to", "Trash", "--json", "42",
      ]);
      expect(argv).not.toContain("--mailbox");
    });

    it("keeps the positional target on himalaya v1", async () => {
      setupMock("{}", "", "himalaya 1.1.0");
      const client = new HimalayaClient();
      await client.moveMessage("42", "Archive", "Sent Items");

      const argv = argvOf(mockExecFileAsync.mock.calls[1]);
      expect(argv).toEqual([
        "message", "move", "Archive", "42", "--folder", "Sent Items", "--output", "json",
      ]);
    });

    it("passes account when specified", async () => {
      setupMock("{}");
      const client = new HimalayaClient();
      await client.moveMessage("42", "Trash", undefined, "work");

      const argv = argvOf(mockExecFileAsync.mock.calls[1]);
      expect(argv).toEqual([
        "message", "move", "--from", "INBOX", "--to", "Trash", "--account", "work", "--json", "42",
      ]);
    });
  });

  describe("deleteMessage", () => {
    it("passes the mailbox to message delete on v2.1+", async () => {
      setupMock("{}");
      const client = new HimalayaClient();
      await client.deleteMessage("42", "Archive");

      const argv = argvOf(mockExecFileAsync.mock.calls[1]);
      expect(argv).toEqual([
        "message", "delete", "--mailbox", "Archive", "--json", "42",
      ]);
    });

    it("passes INBOX instead of omitting it", async () => {
      setupMock("{}");
      const client = new HimalayaClient();
      await client.deleteMessage("42");

      const argv = argvOf(mockExecFileAsync.mock.calls[1]);
      expect(argv).toEqual([
        "message", "delete", "--mailbox", "INBOX", "--json", "42",
      ]);
    });

    it("moves to the provider trash on v2.0, which has no message delete", async () => {
      setupMock("{}", "", "himalaya v2.0.0 +gmail +imap");
      const client = new HimalayaClient();
      await client.deleteMessage("42", "Sent Items", "gmail-work");

      const argv = argvOf(mockExecFileAsync.mock.calls[1]);
      expect(argv).toEqual([
        "message", "move", "--from", "Sent Items", "--to", "[Gmail]/Trash", "--account", "gmail-work", "--json", "42",
      ]);
    });

    it("uses message delete with --folder on v1", async () => {
      setupMock("{}", "", "himalaya 1.1.0");
      const client = new HimalayaClient();
      await client.deleteMessage("42", "Sent Items");

      const argv = argvOf(mockExecFileAsync.mock.calls[1]);
      expect(argv).toEqual([
        "message", "delete", "--folder", "Sent Items", "--output", "json", "42",
      ]);
    });
  });
});
