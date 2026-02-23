/**
 * SessionEvent — all inputs to `SessionRuntime.process()`.
 *
 * Every external stimulus that can change session state is represented as a
 * SessionEvent variant. The runtime dispatches on `event.type` and delegates
 * to the appropriate handler/reducer. This gives us a single entry point,
 * making the runtime easier to reason about and test.
 *
 * @module SessionControl
 */

import type { WebSocketLike } from "../../interfaces/transport.js";
import type { InboundCommand, PolicyCommand } from "../interfaces/runtime-commands.js";
import type { UnifiedMessage } from "../types/unified-message.js";

/**
 * Discriminated union of all events that SessionRuntime.process() accepts.
 *
 * - BACKEND_MESSAGE: A message received from the backend adapter (CLI/API).
 * - INBOUND_COMMAND: A command received from a connected consumer (WebSocket).
 * - POLICY_COMMAND: A command from a policy service (reconnect, idle, capabilities).
 * - LIFECYCLE_SIGNAL: A lifecycle signal (backend connected/disconnected, session closed).
 */
export type SessionEvent =
  | { type: "BACKEND_MESSAGE"; message: UnifiedMessage }
  | { type: "INBOUND_COMMAND"; command: InboundCommand; ws: WebSocketLike }
  | { type: "POLICY_COMMAND"; command: PolicyCommand }
  | {
      type: "LIFECYCLE_SIGNAL";
      signal: "backend:connected" | "backend:disconnected" | "session:closed";
    };
