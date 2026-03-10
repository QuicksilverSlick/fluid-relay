/**
 * Team Coordinator — active task queue with claim/release semantics.
 *
 * Upgrades the existing passive team layer (which only tracks presence)
 * into an active coordination system where multiple agent sessions can:
 *
 *   - claim(taskId, agentId)   — atomically assign a task to an agent
 *   - release(taskId, agentId) — release a claimed task back to the pool
 *   - complete(taskId, agentId) — mark a task done
 *   - enqueue(task)            — add work to the shared queue
 *   - getAvailable()           — list unclaimed pending tasks
 *
 * All operations are idempotent and safe for concurrent access from
 * multiple SessionRuntimes within the same BeamCode hub.
 *
 * The coordinator emits TeamTaskEvents through the existing DomainEventBus
 * so the fan-out broadcast infrastructure picks them up automatically.
 *
 * @module Team
 */

import { randomUUID } from "node:crypto";
import type { TeamTask } from "../types/team-types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskEnqueueParams {
  subject: string;
  description?: string;
  /** Optional initial assignee. If omitted, task enters the pool as "pending". */
  owner?: string;
  /** Blocked-by dependency list (task IDs). */
  blockedBy?: string[];
}

export interface ClaimResult {
  success: boolean;
  task?: TeamTask;
  reason?: string;
}

export type TeamCoordinatorEvent =
  | { type: "task_enqueued"; task: TeamTask }
  | { type: "task_claimed"; task: TeamTask; agentId: string }
  | { type: "task_released"; task: TeamTask; agentId: string }
  | { type: "task_completed"; task: TeamTask; agentId: string }
  | { type: "task_failed"; task: TeamTask; agentId: string; reason: string };

export type CoordinatorListener = (event: TeamCoordinatorEvent) => void;

// ---------------------------------------------------------------------------
// Team Coordinator
// ---------------------------------------------------------------------------

export class TeamCoordinator {
  private tasks = new Map<string, TeamTask>();
  private listeners = new Set<CoordinatorListener>();

  /** Current snapshot of the task queue. */
  get allTasks(): TeamTask[] {
    return [...this.tasks.values()];
  }

  /** Tasks available for claiming (pending, no unmet blockers). */
  getAvailable(): TeamTask[] {
    return [...this.tasks.values()].filter(
      (t) =>
        t.status === "pending" &&
        !t.owner &&
        t.blockedBy.every((dep) => {
          const blocker = this.tasks.get(dep);
          return blocker?.status === "completed";
        }),
    );
  }

  /** Tasks currently assigned to a specific agent. */
  getByAgent(agentId: string): TeamTask[] {
    return [...this.tasks.values()].filter(
      (t) => t.owner === agentId && t.status === "in_progress",
    );
  }

  /**
   * Add a task to the shared queue.
   * Returns the created task with a generated ID.
   */
  enqueue(params: TaskEnqueueParams): TeamTask {
    const task: TeamTask = {
      id: randomUUID(),
      subject: params.subject,
      description: params.description,
      status: params.owner ? "in_progress" : "pending",
      owner: params.owner,
      blockedBy: params.blockedBy ?? [],
      blocks: [],
    };

    this.tasks.set(task.id, task);

    // Wire up reverse dependency links
    for (const depId of task.blockedBy) {
      const dep = this.tasks.get(depId);
      if (dep && !dep.blocks.includes(task.id)) {
        const updated = { ...dep, blocks: [...dep.blocks, task.id] };
        this.tasks.set(depId, updated);
      }
    }

    this.emit({ type: "task_enqueued", task });
    return task;
  }

  /**
   * Atomically claim a task for an agent.
   *
   * Fails if:
   *   - Task doesn't exist
   *   - Task is already claimed by another agent
   *   - Task has unmet blockers
   *   - Task is completed/deleted
   */
  claim(taskId: string, agentId: string): ClaimResult {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, reason: "Task not found" };
    }

    if (task.status === "completed" || task.status === "deleted") {
      return { success: false, reason: `Task is ${task.status}` };
    }

    if (task.owner && task.owner !== agentId) {
      return {
        success: false,
        reason: `Task already claimed by ${task.owner}`,
      };
    }

    // Idempotent: already claimed by this agent
    if (task.owner === agentId && task.status === "in_progress") {
      return { success: true, task };
    }

    // Check blockers
    const unblockedBlockers = task.blockedBy.filter((dep) => {
      const blocker = this.tasks.get(dep);
      return !blocker || blocker.status !== "completed";
    });

    if (unblockedBlockers.length > 0) {
      return {
        success: false,
        reason: `Blocked by: ${unblockedBlockers.join(", ")}`,
      };
    }

    const claimed: TeamTask = {
      ...task,
      status: "in_progress",
      owner: agentId,
    };
    this.tasks.set(taskId, claimed);

    this.emit({ type: "task_claimed", task: claimed, agentId });
    return { success: true, task: claimed };
  }

  /**
   * Release a claimed task back to the pool.
   * Only the current owner can release.
   */
  release(taskId: string, agentId: string): ClaimResult {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, reason: "Task not found" };
    }

    if (task.owner !== agentId) {
      return {
        success: false,
        reason: task.owner ? `Task owned by ${task.owner}, not ${agentId}` : "Task is not claimed",
      };
    }

    const released: TeamTask = {
      ...task,
      status: "pending",
      owner: undefined,
    };
    this.tasks.set(taskId, released);

    this.emit({ type: "task_released", task: released, agentId });
    return { success: true, task: released };
  }

  /**
   * Mark a task as completed.
   * Only the current owner can complete. Also unblocks dependent tasks.
   */
  complete(taskId: string, agentId: string): ClaimResult {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, reason: "Task not found" };
    }

    if (task.owner !== agentId) {
      return {
        success: false,
        reason: task.owner ? `Task owned by ${task.owner}, not ${agentId}` : "Task is not claimed",
      };
    }

    const completed: TeamTask = {
      ...task,
      status: "completed",
    };
    this.tasks.set(taskId, completed);

    this.emit({ type: "task_completed", task: completed, agentId });
    return { success: true, task: completed };
  }

  /**
   * Mark a task as failed and release it back to the pool.
   */
  fail(taskId: string, agentId: string, reason: string): ClaimResult {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, reason: "Task not found" };
    }

    if (task.owner !== agentId) {
      return {
        success: false,
        reason: task.owner ? `Task owned by ${task.owner}, not ${agentId}` : "Task is not claimed",
      };
    }

    const failed: TeamTask = {
      ...task,
      status: "pending",
      owner: undefined,
    };
    this.tasks.set(taskId, failed);

    this.emit({ type: "task_failed", task: failed, agentId, reason });
    return { success: true, task: failed };
  }

  /**
   * Remove a task from the queue entirely.
   */
  delete(taskId: string): boolean {
    return this.tasks.delete(taskId);
  }

  /** Subscribe to coordinator events. */
  on(listener: CoordinatorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Clear all tasks and listeners. */
  reset(): void {
    this.tasks.clear();
    this.listeners.clear();
  }

  private emit(event: TeamCoordinatorEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors break the coordinator.
      }
    }
  }
}
