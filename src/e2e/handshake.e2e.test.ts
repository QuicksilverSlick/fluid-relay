import { describe, expect, it } from "vitest";
import { createProcessManager } from "../testing/session-test-utils.js";
import { getE2EProfile } from "./e2e-profile.js";
import { getRealCliPrereqState } from "./prereqs.js";

describe("E2E Real CLI handshake smoke", () => {
  const prereqs = getRealCliPrereqState();

  it("runs under real profile", () => {
    const profile = getE2EProfile();
    // In e2e tests, undefined (not set) is treated as real-full default
    expect(["real-smoke", "real-full", undefined]).toContain(profile);
  });

  it.runIf(prereqs.ok)("spawns claude --version and exits cleanly", async () => {
    const pm = createProcessManager();
    const handle = pm.spawn({
      command: "claude",
      args: ["--version"],
      cwd: process.cwd(),
      env: process.env,
    });

    expect(typeof handle.pid).toBe("number");
    expect(pm.isAlive(handle.pid)).toBe(true);

    const code = await handle.exited;
    expect(code).toBe(0);
  });
});
