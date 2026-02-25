import { spawn as nodeSpawn } from "node:child_process";
import { Readable } from "node:stream";
import type { ProcessHandle, ProcessManager, SpawnOptions } from "../interfaces/process-manager.js";

/**
 * Node.js process manager using child_process.spawn.
 * Requires Node 22+ for Readable.toWeb().
 */
export class NodeProcessManager implements ProcessManager {
  spawn(options: SpawnOptions): ProcessHandle {
    const child = nodeSpawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv | undefined,
      stdio: ["ignore", "pipe", "pipe"],
      // Create a new process group so kill can reach descendant processes.
      // Without this, wrapper scripts (e.g. opencode's Node shim calling
      // spawnSync for the real Go binary) leave orphaned grandchildren.
      detached: true,
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

    // Fabricate the exited Promise from the "exit" event
    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", (code, signal) => {
        // null code when killed by signal
        resolve(signal ? null : (code ?? null));
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
          // Process group may already be gone; try direct kill as fallback
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
