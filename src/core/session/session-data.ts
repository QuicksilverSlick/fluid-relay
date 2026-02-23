/**
 * SessionData — the serializable, immutable slice of a session.
 *
 * All fields are readonly. Only SessionRuntime may produce new SessionData
 * objects (by spreading: `{ ...data, state: newState }`). Nothing else may
 * mutate session state — the compiler enforces this.
 *
 * @module SessionControl
 */
import type { PermissionRequest } from "../../types/cli-messages.js";
import type { ConsumerMessage } from "../../types/consumer-messages.js";
import type { SessionState } from "../../types/session-state.js";
import type { UnifiedMessage } from "../types/unified-message.js";
import type { QueuedMessage } from "./session-repository.js";

export interface SessionData {
  /** Extracted from `session_init`. Absent until first backend connection. */
  readonly backendSessionId?: string;
  readonly state: SessionState;
  readonly pendingPermissions: ReadonlyMap<string, PermissionRequest>;
  readonly messageHistory: readonly ConsumerMessage[];
  readonly pendingMessages: readonly UnifiedMessage[];
  readonly queuedMessage: QueuedMessage | null;
  readonly lastStatus: "compacting" | "idle" | "running" | null;
  readonly adapterName?: string;
  readonly adapterSupportsSlashPassthrough: boolean;
}
