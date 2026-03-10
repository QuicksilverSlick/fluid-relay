import { spawn as nodeSpawn } from "node:child_process";
import { Readable } from "node:stream";
import type { ProcessHandle, ProcessManager, SpawnOptions } from "../interfaces/process-manager.js";

/**
 * Polls until no process in the group with the given PGID is alive, or until
 * timeoutMs elapses. Resolves in both cases — the caller (killProcess) handles
 * any remaining stragglers via SIGKILL.
 *
 * Only meaningful when the child was spawned with detached:true so that
 * child.pid === child's PGID (it is the process group leader).
 */
const PROCESS_GROUP_POLL_INTERVAL_MS = 50;

function waitForProcessGroupDead(pgid: number, timeoutMs = 30_000): Promise<void> {
  return new Promise<void>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      try {
        process.kill(-pgid, 0); // no-op if group still exists; throws if gone
        if (Date.now() >= deadline) {
          resolve();
          return;
        }
        setTimeout(poll, PROCESS_GROUP_POLL_INTERVAL_MS);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          // Group is gone — all members have exited.
          resolve();
        } else if (code === "EPERM") {
          // Permission denied: the group still exists but we cannot signal it.
          // Keep polling so the killProcess() caller can escalate to SIGKILL.
          if (Date.now() >= deadline) {
            resolve();
          } else {
            setTimeout(poll, PROCESS_GROUP_POLL_INTERVAL_MS);
          }
        } else {
          // Unexpected error — resolve to avoid an infinite loop.
          resolve();
        }
      }
    };
    poll();
  });
}

/**
 * Node.js process manager using child_process.spawn.
 * Requires Node 22+ for Readable.toWeb().
 */
export class NodeProcessManager implements ProcessManager {
  spawn(options: SpawnOptions): ProcessHandle {
    // On Windows, .cmd/.bat wrappers (e.g. claude.cmd, codex.cmd) need
    // shell: true to execute. detached: true causes EINVAL on Windows
    // when combined with .cmd files, so we only enable it on Unix where
    // process-group kills (kill -PGID) are supported.
    const isWindows = process.platform === "win32";
    const needsShell = isWindows && /\.cmd$/i.test(options.command);
    const child = nodeSpawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv | undefined,
      stdio: ["ignore", "pipe", "pipe"],
      // Create a new process group so kill can reach descendant processes.
      // Without this, wrapper scripts (e.g. opencode's Node shim calling
      // spawnSync for the real Go binary) leave orphaned grandchildren.
      // On Windows, detached creates a new console window; we skip it for
      // .cmd wrappers to avoid EINVAL.
      detached: !isWindows,
      shell: needsShell,
    });

    // Attach an early error listener immediately after spawn() so ENOENT-style
    // failures cannot surface as unhandled exceptions before we build the handle.
    const earlyErrorListener = () => {};
    child.on("error", earlyErrorListener);

    if (typeof child.pid !== "number") {
      throw new Error(`Failed to spawn process: ${options.command}`);
    }

    const pid = child.pid;

    // Wrap Node Readable streams to web ReadableStream via Readable.toWeb() (Node 22+)
    const stdout = child.stdout
      ? (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>)
      : null;
    const stderr = child.stderr
      ? (Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>)
      : null;

    // Fabricate the exited Promise. It resolves only after the *entire process
    // group* is gone — not just the direct child. This matters for wrapper
    // binaries (e.g. the opencode Node shim) that use spawnSync internally:
    // the direct child exits on SIGTERM while the grandchild (Go binary) is
    // still doing its graceful shutdown. Without this extra wait, killProcess()
    // returns too early and the grandchild appears as an orphan.
    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", (code, signal) => {
        const exitCode = signal ? null : (code ?? null);
        // After the direct child exits, wait for any remaining members of the
        // process group (grandchildren spawned via spawnSync) to also exit.
        waitForProcessGroupDead(pid).then(() => resolve(exitCode));
      });
      child.on("error", () => {
        resolve(null);
      });
    });

    // Real error handlers are now attached; remove the early no-op listener.
    child.off("error", earlyErrorListener);

    return {
      pid,
      exited,
      kill(signal: "SIGTERM" | "SIGKILL" | "SIGINT" = "SIGTERM") {
        try {
          // Kill the entire process group (negative PID) so descendant
          // processes spawned by wrapper scripts are also terminated.
          process.kill(-pid, signal);
        } catch {
          // ESRCH: process group already gone.
          // EINVAL: negative PID unsupported on Windows — falls back to direct
          //   child kill, restoring the original (non-group) behavior on Windows.
          try {
            child.kill(signal);
          } catch {
            // Process is dead
          }
        }
      },
      stdout,
      stderr,
    };
  }

  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
