/**
 * himalaya CLI version detection.
 *
 * himalaya made a breaking CLI change at v2.0.0 (subcommand `folder`->`mailbox`,
 * flag `--output json`->`--json`, `folder create`/`folder delete` dropped from
 * the shared API). HimalayaClient needs to know which syntax generation the
 * installed binary speaks before building any args.
 *
 * No module-level cache here by design: HimalayaClient caches per-instance
 * (lazy, on first exec()); doctor calls this fresh every run since it's a
 * one-shot CLI invocation in its own process with nothing to share.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { versionDetectionError } from "./errors.js";

const execFileAsync = promisify(execFile);

// Independent of HimalayaClient's command timeout (default 120s) -- a hung
// or misbehaving binary should stall the version probe briefly, not the
// whole first tool call. 15s (not 5s) so a slow/loaded environment (Docker
// CI, cold start) does not false-fail the probe; the probe runs once per
// client instance, so the extra worst-case latency is bounded and rare.
const VERSION_PROBE_TIMEOUT_MS = 15_000;

export interface HimalayaVersion {
  /** Major version number, e.g. 2 for "himalaya v2.0.0 ...". */
  major: number;
  /** Minor version number, e.g. 2 for "himalaya v2.2.1 ...". */
  minor: number;
  /** Patch version number, e.g. 1 for "himalaya v2.2.1 ...". */
  patch: number;
  /** Raw `--version` stdout, trimmed, for diagnostics/logging. */
  raw: string;
}

// Matches "himalaya v2.0.0 +gmail ..." (confirmed live format) and a bare
// "1.1.0"-style form without the "v" prefix -- real v1.x --version output
// was never independently verified (only v2.0.0 was live-tested), so the
// "v" is optional rather than assumed present. Minor and patch matter: v2.0
// removed `message delete` and renamed move's positional target to `--to`,
// and v2.1 put `message delete` back.
const VERSION_RE = /\bv?(\d+)\.(\d+)\.(\d+)\b/;

/** True when `version` is at least major.minor.patch. Missing parts count as 0. */
export function himalayaAtLeast(
  version: HimalayaVersion,
  major: number,
  minor = 0,
  patch = 0,
): boolean {
  const gotMinor = version.minor ?? 0;
  const gotPatch = version.patch ?? 0;
  if (version.major !== major) return version.major > major;
  if (gotMinor !== minor) return gotMinor > minor;
  return gotPatch >= patch;
}

/**
 * Run `<binary> --version` and extract the major version number.
 * Throws a HimalayaError (code: "himalaya_version_undetected") on timeout,
 * nonzero exit, or unparseable/empty output -- callers must not silently
 * default to a syntax branch on failure.
 */
export async function detectHimalayaVersion(binary: string): Promise<HimalayaVersion> {
  let stdout: string;
  try {
    const result = await execFileAsync(binary, ["--version"], {
      timeout: VERSION_PROBE_TIMEOUT_MS,
    });
    stdout = result.stdout.trim();
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw versionDetectionError(detail);
  }

  const match = VERSION_RE.exec(stdout);
  if (!match) {
    throw versionDetectionError(`unrecognized --version output: "${stdout || "(empty)"}"`);
  }

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    raw: stdout,
  };
}
