/**
 * Coverage tests targeting lines 62-63 of acp-adapter.ts:
 * the branch where spawn returns a child process with missing stdin/stdout pipes.
 *
 * Branch: `if (!child.stdin || !child.stdout) { child.kill(); throw ... }`
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { SpawnFn } from "./acp-adapter.js";
import { AcpAdapter } from "./acp-adapter.js";

function makeMinimalChild(overrides: Partial<{ stdin: unknown; stdout: unknown }>): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const kill = vi.fn((_signal?: string) => true);
  Object.assign(child, {
    stdin: overrides.stdin ?? null,
    stdout: overrides.stdout ?? null,
    stderr: new EventEmitter(),
    pid: 99999,
    killed: false,
    kill,
  });
  return child;
}

describe("AcpAdapter — missing stdio pipes (lines 62-63)", () => {
  it("kills child and throws when stdin is null", async () => {
    // Spawn returns a child whose stdin is null (e.g. stdio: 'ignore')
    const child = makeMinimalChild({ stdin: null, stdout: new EventEmitter() });
    const spawnFn: SpawnFn = vi.fn(() => child);

    const adapter = new AcpAdapter(spawnFn);
    await expect(adapter.connect({ sessionId: "sess-no-stdin" })).rejects.toThrow(
      "Failed to open stdio pipes for ACP subprocess",
    );

    expect(child.kill).toHaveBeenCalled();
  });

  it("kills child and throws when stdout is null", async () => {
    // Spawn returns a child whose stdout is null
    const child = makeMinimalChild({ stdin: new EventEmitter(), stdout: null });
    const spawnFn: SpawnFn = vi.fn(() => child);

    const adapter = new AcpAdapter(spawnFn);
    await expect(adapter.connect({ sessionId: "sess-no-stdout" })).rejects.toThrow(
      "Failed to open stdio pipes for ACP subprocess",
    );

    expect(child.kill).toHaveBeenCalled();
  });

  it("kills child and throws when both stdin and stdout are null", async () => {
    const child = makeMinimalChild({ stdin: null, stdout: null });
    const spawnFn: SpawnFn = vi.fn(() => child);

    const adapter = new AcpAdapter(spawnFn);
    await expect(adapter.connect({ sessionId: "sess-no-pipes" })).rejects.toThrow(
      "Failed to open stdio pipes for ACP subprocess",
    );

    expect(child.kill).toHaveBeenCalled();
  });
});
