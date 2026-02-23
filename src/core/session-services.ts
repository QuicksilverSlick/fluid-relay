/**
 * SessionServices — flat registry of all services produced by buildSessionServices.
 *
 * @module SessionControl
 */

import type { GitInfoResolver } from "../interfaces/git-resolver.js";
import type { Logger } from "../interfaces/logger.js";
import type { MetricsCollector } from "../interfaces/metrics.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import type {
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
} from "../types/cli-messages.js";
import type { ResolvedConfig } from "../types/config.js";
import type { BackendConnector } from "./backend/backend-connector.js";
import type { CapabilitiesPolicy } from "./capabilities/capabilities-policy.js";
import type { ConsumerBroadcaster } from "./consumer/consumer-broadcaster.js";
import type { ConsumerGateway } from "./consumer/consumer-gateway.js";
import type { InboundCommand, PolicyCommand } from "./interfaces/runtime-commands.js";
import type { MessageTracer } from "./messaging/message-tracer.js";
import type { LifecycleState } from "./session/session-lifecycle.js";
import type { Session, SessionRepository } from "./session/session-repository.js";
import type { SessionRuntime } from "./session/session-runtime.js";
import type { UnifiedMessage } from "./types/unified-message.js";

/** Core infra context threaded through all session services. */
export type BridgeCoreContext = {
  logger: Logger;
  config: ResolvedConfig;
  tracer: MessageTracer;
  gitResolver: GitInfoResolver | null;
  metrics: MetricsCollector | null;
};

export interface RuntimeManagerApi {
  getOrCreate(session: Session): SessionRuntime;
  get(sessionId: string): SessionRuntime | undefined;
  has(sessionId: string): boolean;
  delete(sessionId: string): boolean;
  clear(): void;
  keys(): IterableIterator<string>;
  getLifecycleState(sessionId: string): LifecycleState | undefined;
}

export interface RuntimeApiFacade {
  sendUserMessage(
    sessionId: string,
    text: string,
    options?: {
      traceId?: string;
      slashRequestId?: string;
      slashCommand?: string;
      images?: { media_type: string; data: string }[];
    },
  ): void;
  executeSlashCommand(
    sessionId: string,
    command: string,
  ): Promise<{ content: string; source: "emulated" } | null>;
  applyPolicyCommand(sessionId: string, command: PolicyCommand): void;
  handleBackendMessage(sessionId: string, message: UnifiedMessage): void;
  handleInboundCommand(sessionId: string, msg: InboundCommand, ws: WebSocketLike): void;
  handleLifecycleSignal(
    sessionId: string,
    signal: "backend:connected" | "backend:disconnected" | "session:closed",
  ): void;
  sendInterrupt(sessionId: string): void;
  sendSetModel(sessionId: string, model: string): void;
  sendSetPermissionMode(sessionId: string, mode: string): void;
  sendPermissionResponse(
    sessionId: string,
    requestId: string,
    behavior: "allow" | "deny",
    options?: {
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: unknown[];
      message?: string;
    },
  ): void;
  getSupportedModels(sessionId: string): InitializeModel[];
  getSupportedCommands(sessionId: string): InitializeCommand[];
  getAccountInfo(sessionId: string): InitializeAccount | null;
  sendToBackend(sessionId: string, message: UnifiedMessage): void;
}

export interface LifecycleServiceFacade {
  getOrCreateSession(sessionId: string): Session;
  removeSession(sessionId: string): void;
  closeSession(sessionId: string): Promise<void>;
  closeAllSessions(): Promise<void>;
}

export interface SessionServices {
  /** Resolved config, logger, tracer, gitResolver, metrics. */
  readonly core: BridgeCoreContext;
  /** Session data store. */
  readonly store: SessionRepository;
  /** Per-session runtime map (getOrCreate, get, delete, etc.). */
  readonly runtimeManager: RuntimeManagerApi;
  /** Programmatic runtime operations (send, interrupt, slash commands, etc.). */
  readonly runtimeApi: RuntimeApiFacade;
  /** Backend connector (connect/disconnect/query). */
  readonly backendConnector: BackendConnector;
  /** Capabilities handshake policy. */
  readonly capabilitiesPolicy: CapabilitiesPolicy;
  /** Session lifecycle (getOrCreate, close, remove). */
  readonly lifecycleService: LifecycleServiceFacade;
  /** Consumer WebSocket gateway (open/message/close). */
  readonly consumerGateway: ConsumerGateway;
  /** Broadcaster (needed by services that broadcast to all consumers). */
  readonly broadcaster: ConsumerBroadcaster;
}
