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
  try {
    if (pid !== undefined) process.kill(-pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}
