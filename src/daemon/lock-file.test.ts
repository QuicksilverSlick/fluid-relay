import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireLock, isLockStale, releaseLock } from "./lock-file.js";

// Mock unlink so it can be overridden per-test for race condition scenarios.
// The default implementation delegates to the real unlink.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, unlink: vi.fn().mockImplementation(actual.unlink) };
});

describe("lock-file", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "beamcode-lock-test-"));
    lockPath = join(dir, "daemon.lock");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("acquires a lock and writes PID", async () => {
    await acquireLock(lockPath);
    const content = await readFile(lockPath, "utf-8");
    expect(parseInt(content, 10)).toBe(process.pid);
  });

  it("double-acquire throws with PID message", async () => {
    await acquireLock(lockPath);
    await expect(acquireLock(lockPath)).rejects.toThrow(
      `Daemon already running (PID: ${process.pid})`,
    );
  });

  it("detects stale lock from dead PID", async () => {
    // Write a lock file with a PID that almost certainly doesn't exist
    const { writeFile } = await import("node:fs/promises");
    await writeFile(lockPath, "999999999", "utf-8");

    expect(await isLockStale(lockPath)).toBe(true);
  });

  it("detects non-stale lock from alive PID", async () => {
    await acquireLock(lockPath);
    expect(await isLockStale(lockPath)).toBe(false);
  });

  it("re-acquires after stale lock", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(lockPath, "999999999", "utf-8");

    // Should succeed because the stale lock is removed
    await acquireLock(lockPath);
    const content = await readFile(lockPath, "utf-8");
    expect(parseInt(content, 10)).toBe(process.pid);
  });

  it("releases a lock", async () => {
    await acquireLock(lockPath);
    await releaseLock(lockPath);

    // Should be able to acquire again
    await acquireLock(lockPath);
    const content = await readFile(lockPath, "utf-8");
    expect(parseInt(content, 10)).toBe(process.pid);
  });

  it("release is idempotent", async () => {
    await releaseLock(lockPath);
    // No throw
  });

  // -----------------------------------------------------------------------
  // Non-EEXIST error rethrown
  // -----------------------------------------------------------------------

  it("rethrows non-EEXIST errors (e.g. ENOENT)", async () => {
    // Use a path whose parent directory does not exist → triggers ENOENT (not EEXIST)
    const badPath = "/nonexistent-dir-abc123/daemon.lock";
    await expect(acquireLock(badPath)).rejects.toThrow();
    // The error should NOT be about "already running"
    try {
      await acquireLock(badPath);
    } catch (err) {
      expect((err as Error).message).not.toContain("already running");
    }
  });

  // -----------------------------------------------------------------------
  // Second attempt EEXIST after stale removal → "Daemon already running"
  // -----------------------------------------------------------------------

  it("reports 'Daemon already running' when second attempt hits EEXIST", async () => {
    // Create a lock file with a dead PID so isLockStale returns true
    const { writeFile } = await import("node:fs/promises");
    await writeFile(lockPath, "999999999", "utf-8");

    // First acquire should succeed because the stale lock is removed and retried
    await acquireLock(lockPath);
    const content = await readFile(lockPath, "utf-8");
    expect(parseInt(content, 10)).toBe(process.pid);

    // Now the lock is held by us (alive PID). Second acquire should fail
    // with "Daemon already running" because isLockStale returns false
    await expect(acquireLock(lockPath)).rejects.toThrow(
      `Daemon already running (PID: ${process.pid})`,
    );
  });

  // -----------------------------------------------------------------------
  // isLockStale returns true when file doesn't exist
  // -----------------------------------------------------------------------

  it("isLockStale returns true when lock file does not exist", async () => {
    // lockPath doesn't exist yet (no lock acquired)
    const stale = await isLockStale(lockPath);
    expect(stale).toBe(true);
  });

  // -----------------------------------------------------------------------
  // isLockStale with non-numeric content
  // -----------------------------------------------------------------------

  it("isLockStale returns true for non-numeric content", async () => {
    await writeFile(lockPath, "not-a-number", "utf-8");

    const stale = await isLockStale(lockPath);
    expect(stale).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Race: unlink ENOENT (another process removed stale lock before us)
  // AND second attempt also hits EEXIST (another process won the race)
  // Covers lines 35 (ENOENT ignored) and 24-25 (attempt > 0 → throw)
  // -----------------------------------------------------------------------

  it("handles unlink ENOENT and throws 'Daemon already running' when retry also hits EEXIST", async () => {
    // Create a stale lock file with a dead PID
    await writeFile(lockPath, "999999999", "utf-8");

    // Override unlink once to throw ENOENT (another process already removed it before us)
    vi.mocked(unlink).mockRejectedValueOnce(
      Object.assign(new Error("no such file or directory"), { code: "ENOENT" }),
    );

    // acquireLock flow:
    // attempt=0: open("wx") → EEXIST (file exists)
    //   isLockStale → true (dead PID 999999999)
    //   unlink → throws ENOENT (mocked) → line 35 catches and ignores
    //   continue → attempt=1
    // attempt=1: open("wx") → EEXIST (file still exists, unlink was mocked away)
    //   attempt > 0 → lines 24-25 execute → throw "Daemon already running"
    await expect(acquireLock(lockPath)).rejects.toThrow("Daemon already running (PID: 999999999)");
  });
});
