/**
 * Coverage tests targeting the uncovered branch in state-file.ts:
 *
 *   Line 31: err instanceof Error ? err.message : String(err)
 *            The false branch (String(err)) executes when the thrown value
 *            is not an Error instance (e.g. a plain string or number).
 */

import { chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonState } from "./state-file.js";
import { writeState } from "./state-file.js";

// Mock fs/promises so we can control what writeFile/rename/chmod throw.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn().mockImplementation(actual.writeFile),
    rename: vi.fn().mockImplementation(actual.rename),
    chmod: vi.fn().mockImplementation(actual.chmod),
  };
});

describe("state-file — uncovered branch coverage", () => {
  let dir: string;
  let statePath: string;

  const sampleState: DaemonState = {
    pid: 99999,
    port: 7777,
    heartbeat: 2000,
    version: "0.0.1",
    controlApiToken: "tok",
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "beamcode-state-cov-"));
    statePath = join(dir, "daemon.json");
  });

  afterEach(async () => {
    vi.mocked(writeFile).mockRestore();
    vi.mocked(rename).mockRestore();
    vi.mocked(chmod).mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Line 31: String(err) branch — err is not an Error instance
  // -------------------------------------------------------------------------

  it("uses String(err) in message when thrown value is not an Error instance (line 31)", async () => {
    // Throw a plain string (not an Error) from rename so we enter the catch block.
    // The ternary at line 31: err instanceof Error ? err.message : String(err)
    // takes the false (String) branch.
    vi.mocked(rename).mockRejectedValueOnce("disk quota exceeded");

    await expect(writeState(statePath, sampleState)).rejects.toThrow(
      `Failed to write daemon state to ${statePath}: disk quota exceeded`,
    );
  });

  it("uses err.message when thrown value IS an Error instance (line 31 — true branch, confirming both paths)", async () => {
    const regularError = new Error("rename failed unexpectedly");
    vi.mocked(rename).mockRejectedValueOnce(regularError);

    await expect(writeState(statePath, sampleState)).rejects.toThrow(
      `Failed to write daemon state to ${statePath}: rename failed unexpectedly`,
    );
  });
});
