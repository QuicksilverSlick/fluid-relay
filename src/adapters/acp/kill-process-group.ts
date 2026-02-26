import type { ChildProcess } from "node:child_process";

/**
 * Send a signal to the entire process group (negative PID) so descendant
 * processes spawned by the ACP agent are also terminated.
 *
 * Falls back to `child.kill(signal)` when the PID is unavailable (not yet
 * spawned) or when `process.kill` throws (e.g. process already exited).
 */
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      // Try to kill the whole process group first.
      process.kill(-pid, signal);
      return; // If successful, we're done.
    } catch {
      // Fallback to killing just the child process if group kill fails
      // (e.g. on Windows, or if the process has already exited).
    }
  }

  try {
    child.kill(signal);
  } catch {
    // Process already exited — nothing to do.
  }
}
