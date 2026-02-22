// ─── Class exports ───────────────────────────────────────────────────────────

export { BackendConnector } from "./backend/backend-connector.js";
export { CapabilitiesPolicy } from "./capabilities-policy.js";
export { ConsumerGateway } from "./consumer/consumer-gateway.js";
export type {
  ProcessSupervisorOptions,
  SupervisorEventMap,
} from "./coordinator/process-supervisor.js";
export { ProcessSupervisor } from "./coordinator/process-supervisor.js";
export { DomainEventBus } from "./events/domain-event-bus.js";
export { TypedEventEmitter } from "./events/typed-emitter.js";
// ─── Interface / type re-exports ─────────────────────────────────────────────
export type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "./interfaces/backend-adapter.js";
export type {
  DomainBridgeEventType,
  DomainEvent,
  DomainEventMap,
  DomainEventSource,
  DomainEventType,
} from "./interfaces/domain-events.js";
export type {
  Configurable,
  Encryptable,
  Interruptible,
  PermissionHandler,
  Reconnectable,
  TeamObserver,
} from "./interfaces/extensions.js";
export { IdlePolicy } from "./policies/idle-policy.js";
export { ReconnectPolicy } from "./policies/reconnect-policy.js";
export { CliGateway } from "./session/cli-gateway.js";
export {
  isLifecycleTransitionAllowed,
  LIFECYCLE_STATES,
  type LifecycleState,
} from "./session/session-lifecycle.js";
export { SessionRepository } from "./session/session-repository.js";
export { SessionRuntime } from "./session/session-runtime.js";
export { SessionBridge } from "./session-bridge.js";
export { SessionCoordinator, type SessionCoordinatorOptions } from "./session-coordinator.js";
export type {
  CoreSessionState,
  DevToolSessionState,
} from "./types/core-session-state.js";
export type { SequencedMessage } from "./types/sequenced-message.js";
export type {
  TeamEvent,
  TeamIdleEvent,
  TeamMember,
  TeamMemberEvent,
  TeamMessageEvent,
  TeamPlanApprovalRequestEvent,
  TeamPlanApprovalResponseEvent,
  TeamShutdownRequestEvent,
  TeamShutdownResponseEvent,
  TeamState,
  TeamTask,
  TeamTaskEvent,
} from "./types/team-types.js";
export { isTeamMember, isTeamState, isTeamTask } from "./types/team-types.js";
// ─── Unified message types ───────────────────────────────────────────────────
export type {
  UnifiedContent,
  UnifiedMessage,
  UnifiedMessageType,
} from "./types/unified-message.js";
export {
  canonicalize,
  createUnifiedMessage,
  isTeamMessage,
  isTeamStateChange,
  isTeamTaskUpdate,
  isUnifiedMessage,
} from "./types/unified-message.js";
