/**
 * Coverage tests targeting uncovered branches in lock-file.ts:
 *
 *   Line 35: unlinkErr.code !== "ENOENT" → throw unlinkErr
 *            (non-ENOENT error from unlink during stale-lock removal is re-thrown)
 *
 *   Line 79: err.code !== "ENOENT" → throw err
 *            (non-ENOENT error from unlink during releaseLock is re-thrown)
 */

import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireLock, releaseLock } from "./lock-file.js";

// Mock unlink so we can inject errors for specific branches.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, unlink: vi.fn().mockImplementation(actual.unlink) };
});

describe("lock-file — uncovered branch coverage", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "beamcode-lock-cov-"));
    lockPath = join(dir, "daemon.lock");
  });

  afterEach(async () => {
    vi.mocked(unlink).mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Line 35: non-ENOENT error thrown by unlink during stale-lock removal
  // -------------------------------------------------------------------------

  it("re-throws non-ENOENT unlink errors during stale lock removal (line 35)", async () => {
    // Write a stale lock with a dead PID so isLockStale returns true
    await writeFile(lockPath, "999999999", "utf-8");

    const epermError = Object.assign(new Error("operation not permitted"), {
      code: "EPERM",
    });

    // unlink is called inside the try/catch at line 32-37.
    // When it throws a non-ENOENT error, line 35 must re-throw it.
    vi.mocked(unlink).mockRejectedValueOnce(epermError);

    await expect(acquireLock(lockPath)).rejects.toThrow("operation not permitted");
  });

  // -------------------------------------------------------------------------
  // Line 79: non-ENOENT error thrown by unlink inside releaseLock
  // -------------------------------------------------------------------------

  it("re-throws non-ENOENT unlink errors during releaseLock (line 79)", async () => {
    // Acquire the lock so the file exists
    await acquireLock(lockPath);

    const epermError = Object.assign(new Error("operation not permitted"), {
      code: "EPERM",
    });

    // releaseLock calls unlink; when that throws with a non-ENOENT code,
    // line 79 must re-throw.
    vi.mocked(unlink).mockRejectedValueOnce(epermError);

    await expect(releaseLock(lockPath)).rejects.toThrow("operation not permitted");
  });
});
