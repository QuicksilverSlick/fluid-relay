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

import type { ConsumerIdentity } from "../../interfaces/auth.js";
import type { WebSocketLike } from "../../interfaces/transport.js";
import type { InboundCommand } from "../interfaces/runtime-commands.js";
import type { UnifiedMessage } from "../types/unified-message.js";

/**
 * All system-level signals that can arrive at a session.
 *
 * These are emitted by transport modules (BackendConnector, ConsumerGateway)
 * and policy services — never by the runtime itself.
 */
export type SystemSignal =
  /** Backend adapter connected — hand off the BackendSession. */
  | { kind: "BACKEND_CONNECTED" }
  /** Backend adapter disconnected unexpectedly (stream ended or error). */
  | { kind: "BACKEND_DISCONNECTED"; reason: string }
  /** A consumer WebSocket connected and was authenticated. */
  | { kind: "CONSUMER_CONNECTED"; ws: WebSocketLike; identity: ConsumerIdentity }
  /** A consumer WebSocket disconnected. */
  | { kind: "CONSUMER_DISCONNECTED"; ws: WebSocketLike }
  /** Git info was resolved asynchronously. */
  | { kind: "GIT_INFO_RESOLVED" }
  /** Capabilities handshake completed successfully. */
  | { kind: "CAPABILITIES_READY" }
  /** Session is idle with no consumers — eligible for reaping. */
  | { kind: "IDLE_REAP" }
  /** Backend did not connect within the reconnect grace window. */
  | { kind: "RECONNECT_TIMEOUT" }
  /** Capabilities did not arrive within the timeout window. */
  | { kind: "CAPABILITIES_TIMEOUT" }
  /** Explicit session close initiated by coordinator. */
  | { kind: "SESSION_CLOSED" };

/**
 * Discriminated union of all events that SessionRuntime.process() accepts.
 *
 * - BACKEND_MESSAGE: A message received from the backend adapter (CLI/API).
 * - INBOUND_COMMAND: A command received from a connected consumer (WebSocket).
 * - SYSTEM_SIGNAL:   A lifecycle or connectivity signal from infrastructure.
 */
export type SessionEvent =
  | { type: "BACKEND_MESSAGE"; message: UnifiedMessage }
  | { type: "INBOUND_COMMAND"; command: InboundCommand; ws: WebSocketLike }
  | { type: "SYSTEM_SIGNAL"; signal: SystemSignal };
