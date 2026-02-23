/**
 * SessionBridge — central orchestrator that wires all four bounded contexts together.
 *
 * Owns the session lifecycle and delegates to specialized components:
 * - **ConsumerPlane**: ConsumerGateway, ConsumerGatekeeper, ConsumerBroadcaster
 * - **BackendPlane**: BackendConnector
 * - **MessagePlane**: UnifiedMessageRouter, SlashCommandService
 * - **SessionControl**: CapabilitiesPolicy, GitInfoTracker, SessionRepository
 *
 * Delegates runtime ownership to RuntimeManager.
 *
 * @module SessionControl
 */

import type { AuthContext } from "../interfaces/auth.js";
import type { GitInfoResolver } from "../interfaces/git-resolver.js";
import type { Logger } from "../interfaces/logger.js";
import type { MetricsCollector } from "../interfaces/metrics.js";
import type { SessionStorage } from "../interfaces/storage.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import type {
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
} from "../types/cli-messages.js";
import type { ResolvedConfig } from "../types/config.js";
import type { BridgeEventMap } from "../types/events.js";
import type { SessionSnapshot, SessionState } from "../types/session-state.js";
import type { BackendConnector } from "./backend/backend-connector.js";
import type { BackendApi } from "./bridge/backend-api.js";
import { forwardBridgeEventWithLifecycle } from "./bridge/bridge-event-forwarder.js";
import type { RuntimeApi } from "./bridge/runtime-api.js";
import type { RuntimeManager } from "./bridge/runtime-manager.js";
import type { SessionBroadcastApi } from "./bridge/session-broadcast-api.js";
import type { SessionInfoApi } from "./bridge/session-info-api.js";
import type { SessionLifecycleService } from "./bridge/session-lifecycle-service.js";
import type { SessionPersistenceService } from "./bridge/session-persistence-service.js";
import type { CapabilitiesPolicy } from "./capabilities/capabilities-policy.js";
import type { ConsumerBroadcaster } from "./consumer/consumer-broadcaster.js";
import type { ConsumerGateway } from "./consumer/consumer-gateway.js";
import { TypedEventEmitter } from "./events/typed-emitter.js";
import type { InboundCommand, PolicyCommand } from "./interfaces/runtime-commands.js";
import type { MessageTracer } from "./messaging/message-tracer.js";
import type { GitInfoTracker } from "./session/git-info-tracker.js";
import type { MessageQueueHandler } from "./session/message-queue-handler.js";
import type { LifecycleState } from "./session/session-lifecycle.js";
import type { Session, SessionRepository } from "./session/session-repository.js";
import type { SessionRuntime } from "./session/session-runtime.js";
import { composeBackendPlane } from "./session-bridge/compose-backend-plane.js";
import { composeConsumerPlane } from "./session-bridge/compose-consumer-plane.js";
import { composeMessagePlane } from "./session-bridge/compose-message-plane.js";
import { composeRuntimePlane } from "./session-bridge/compose-runtime-plane.js";
import type { SessionBridgeInitOptions } from "./session-bridge/types.js";
import type { SlashCommandService } from "./slash/slash-command-service.js";
import type { UnifiedMessage } from "./types/unified-message.js";

// ─── SessionBridge ───────────────────────────────────────────────────────────

export class SessionBridge extends TypedEventEmitter<BridgeEventMap> {
  private store: SessionRepository;
  private broadcaster: ConsumerBroadcaster;
  private gitResolver: GitInfoResolver | null;
  private gitTracker: GitInfoTracker;
  private logger: Logger;
  private config: ResolvedConfig;
  private metrics: MetricsCollector | null;
  private slashService: SlashCommandService;
  private queueHandler: MessageQueueHandler;
  private capabilitiesPolicy: CapabilitiesPolicy;
  private backendConnector: BackendConnector;
  private consumerGateway: ConsumerGateway;
  private tracer: MessageTracer;
  private runtimeManager: RuntimeManager;
  private lifecycleService: SessionLifecycleService;
  private runtimeApi: RuntimeApi;
  private broadcastApi: SessionBroadcastApi;
  private backendApi!: BackendApi;
  private infoApi!: SessionInfoApi;
  private persistenceService!: SessionPersistenceService;

  constructor(options?: SessionBridgeInitOptions) {
    super();

    const runtimePlane = composeRuntimePlane({
      options,
      emitPermissionResolved: (sessionId, requestId, behavior) =>
        this.emit("permission:resolved", { sessionId, requestId, behavior }),
      getOrCreateSession: (sessionId) => this.getOrCreateSession(sessionId),
      getBroadcaster: () => this.broadcaster,
      getQueueHandler: () => this.queueHandler,
      getSlashService: () => this.slashService,
      getBackendConnector: () => this.backendConnector,
      getPersistenceService: () => this.persistenceService,
      getGitTracker: () => this.gitTracker,
      // Lazy — both this.capabilitiesPolicy and this.runtimeManager are
      // assigned from the planes below, but only called when the first
      // session runtime is created (well after constructor returns).
      getCapabilitiesPolicy: () => this.capabilitiesPolicy,
      emitEvent: (type, payload) =>
        forwardBridgeEventWithLifecycle(
          this.runtimeManager,
          (eventType, eventPayload) =>
            this.emit(
              eventType as keyof BridgeEventMap,
              eventPayload as BridgeEventMap[keyof BridgeEventMap],
            ),
          type,
          payload,
        ),
    });
    this.store = runtimePlane.store;
    this.runtimeManager = runtimePlane.runtimeManager;
    this.runtimeApi = runtimePlane.runtimeApi;
    this.persistenceService = runtimePlane.persistenceService;
    this.infoApi = runtimePlane.infoApi;
    this.logger = runtimePlane.core.logger;
    this.config = runtimePlane.core.config;
    this.tracer = runtimePlane.core.tracer;
    this.gitResolver = runtimePlane.core.gitResolver;
    this.metrics = runtimePlane.core.metrics;

    const emitEvent = (type: string, payload: unknown) =>
      forwardBridgeEventWithLifecycle(
        this.runtimeManager,
        (eventType, eventPayload) =>
          this.emit(
            eventType as keyof BridgeEventMap,
            eventPayload as BridgeEventMap[keyof BridgeEventMap],
          ),
        type,
        payload,
      );

    const consumerPlane = composeConsumerPlane({
      store: this.store,
      logger: this.logger,
      tracer: this.tracer,
      config: this.config,
      metrics: this.metrics,
      gitResolver: this.gitResolver,
      authenticator: options?.authenticator,
      rateLimiterFactory: options?.rateLimiterFactory,
      runtime: (session) => this.runtime(session),
      routeConsumerMessage: (session, msg, ws) => this.routeConsumerMessage(session, msg, ws),
      emit: (type, payload) => this.emit(type, payload),
    });
    this.broadcaster = consumerPlane.broadcaster;
    this.broadcastApi = consumerPlane.broadcastApi;
    this.gitTracker = consumerPlane.gitTracker;
    this.consumerGateway = consumerPlane.consumerGateway;

    const messagePlane = composeMessagePlane({
      config: this.config,
      logger: this.logger,
      metrics: this.metrics,
      store: this.store,
      runtimeManager: this.runtimeManager,
      tracer: this.tracer,
      gitResolver: this.gitResolver,
      broadcaster: this.broadcaster,
      gitTracker: this.gitTracker,
      persistenceService: this.persistenceService,
      runtime: (session) => this.runtime(session),
      emitEvent,
      emitSessionClosed: (sessionId) => this.emit("session:closed", { sessionId }),
      leaseCoordinator: runtimePlane.leaseCoordinator,
      leaseOwnerId: runtimePlane.leaseOwnerId,
      sendUserMessage: (sessionId, content, options) =>
        this.sendUserMessage(sessionId, content, options),
    });
    this.capabilitiesPolicy = messagePlane.capabilitiesPolicy;
    this.queueHandler = messagePlane.queueHandler;
    this.slashService = messagePlane.slashService;
    this.lifecycleService = messagePlane.lifecycleService;

    const backendPlane = composeBackendPlane({
      options,
      store: this.store,
      logger: this.logger,
      metrics: this.metrics,
      tracer: this.tracer,
      broadcaster: this.broadcaster,
      capabilitiesPolicy: this.capabilitiesPolicy,
      runtime: (session) => this.runtime(session),
      routeBackendMessage: (sessionId, message) =>
        this.runtimeApi.handleBackendMessage(sessionId, message),
      emitEvent,
      getOrCreateSession: (sessionId) => this.getOrCreateSession(sessionId),
    });
    this.backendConnector = backendPlane.backendConnector;
    this.backendApi = backendPlane.backendApi;
  }

  // ── Runtime access ──────────────────────────────────────────────────────

  getLifecycleState(sessionId: string): LifecycleState | undefined {
    return this.runtimeManager.getLifecycleState(sessionId);
  }

  private runtime(session: Session): SessionRuntime {
    return this.runtimeManager.getOrCreate(session);
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  restoreFromStorage(): number {
    return this.persistenceService.restoreFromStorage();
  }

  // ── Session management ───────────────────────────────────────────────────

  getOrCreateSession(sessionId: string): Session {
    return this.lifecycleService.getOrCreateSession(sessionId);
  }

  setAdapterName(sessionId: string, name: string): void {
    this.infoApi.setAdapterName(sessionId, name);
  }

  /** Seed launch-known state (cwd/model) before init arrives from backend. */
  seedSessionState(sessionId: string, params: { cwd?: string; model?: string }): void {
    this.infoApi.seedSessionState(sessionId, params);
  }

  getSession(sessionId: string): SessionSnapshot | undefined {
    return this.infoApi.getSession(sessionId);
  }

  getAllSessions(): SessionState[] {
    return this.infoApi.getAllSessions();
  }

  isCliConnected(sessionId: string): boolean {
    return this.infoApi.isCliConnected(sessionId);
  }

  get storage(): SessionStorage | null {
    return this.infoApi.getStorage();
  }

  removeSession(sessionId: string): void {
    this.lifecycleService.removeSession(sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    return this.lifecycleService.closeSession(sessionId);
  }

  async close(): Promise<void> {
    await this.lifecycleService.closeAllSessions();
    const storage = this.infoApi.getStorage();
    if (storage?.flush) {
      try {
        await storage.flush();
      } catch (error) {
        this.logger.warn("Failed to flush storage during SessionBridge.close()", { error });
      }
    }
    this.tracer.destroy();
    this.removeAllListeners();
  }

  // ── Consumer WebSocket handlers ──────────────────────────────────────────

  handleConsumerOpen(ws: WebSocketLike, context: AuthContext): void {
    this.consumerGateway.handleConsumerOpen(ws, context);
  }

  handleConsumerMessage(ws: WebSocketLike, sessionId: string, data: string | Buffer): void {
    this.consumerGateway.handleConsumerMessage(ws, sessionId, data);
  }

  handleConsumerClose(ws: WebSocketLike, sessionId: string): void {
    this.consumerGateway.handleConsumerClose(ws, sessionId);
  }

  // ── Programmatic API ─────────────────────────────────────────────────────

  sendUserMessage(
    sessionId: string,
    content: string,
    options?: {
      sessionIdOverride?: string;
      images?: { media_type: string; data: string }[];
      traceId?: string;
      slashRequestId?: string;
      slashCommand?: string;
    },
  ): void {
    this.runtimeApi.sendUserMessage(sessionId, content, options);
  }

  sendPermissionResponse(
    sessionId: string,
    requestId: string,
    behavior: "allow" | "deny",
    options?: {
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: unknown[];
      message?: string;
    },
  ): void {
    this.runtimeApi.sendPermissionResponse(sessionId, requestId, behavior, options);
  }

  sendInterrupt(sessionId: string): void {
    this.runtimeApi.sendInterrupt(sessionId);
  }

  sendSetModel(sessionId: string, model: string): void {
    this.runtimeApi.sendSetModel(sessionId, model);
  }

  sendSetPermissionMode(sessionId: string, mode: string): void {
    this.runtimeApi.sendSetPermissionMode(sessionId, mode);
  }

  // ── Structured data APIs ───────────────────────────────────────────────

  getSupportedModels(sessionId: string): InitializeModel[] {
    return this.runtimeApi.getSupportedModels(sessionId);
  }

  getSupportedCommands(sessionId: string): InitializeCommand[] {
    return this.runtimeApi.getSupportedCommands(sessionId);
  }

  getAccountInfo(sessionId: string): InitializeAccount | null {
    return this.runtimeApi.getAccountInfo(sessionId);
  }

  // ── Consumer message routing ─────────────────────────────────────────────

  private routeConsumerMessage(session: Session, msg: InboundCommand, ws: WebSocketLike): void {
    this.runtimeApi.handleInboundCommand(session.id, msg, ws);
  }

  // ── Slash command handling (delegated via SessionRuntime -> SlashCommandService) ─────

  async executeSlashCommand(
    sessionId: string,
    command: string,
  ): Promise<{ content: string; source: "emulated" } | null> {
    return this.runtimeApi.executeSlashCommand(sessionId, command);
  }

  renameSession(sessionId: string, name: string): void {
    this.broadcastNameUpdate(sessionId, name);
    this.emit("session:renamed", { sessionId, name });
  }

  broadcastNameUpdate(sessionId: string, name: string): void {
    this.broadcastApi.broadcastNameUpdate(sessionId, name);
  }

  broadcastResumeFailedToConsumers(sessionId: string): void {
    this.broadcastApi.broadcastResumeFailedToConsumers(sessionId);
  }

  broadcastProcessOutput(sessionId: string, stream: "stdout" | "stderr", data: string): void {
    this.broadcastApi.broadcastProcessOutput(sessionId, stream, data);
  }

  broadcastWatchdogState(
    sessionId: string,
    watchdog: { gracePeriodMs: number; startedAt: number } | null,
  ): void {
    this.broadcastApi.broadcastWatchdogState(sessionId, watchdog);
  }

  broadcastCircuitBreakerState(
    sessionId: string,
    circuitBreaker: { state: string; failureCount: number; recoveryTimeRemainingMs: number },
  ): void {
    this.broadcastApi.broadcastCircuitBreakerState(sessionId, circuitBreaker);
  }

  applyPolicyCommand(sessionId: string, command: PolicyCommand): void {
    this.runtimeApi.applyPolicyCommand(sessionId, command);
  }

  // ── BackendAdapter path (delegated to BackendConnector) ──────────

  get hasAdapter(): boolean {
    return this.backendApi.hasAdapter;
  }

  async connectBackend(
    sessionId: string,
    options?: { resume?: boolean; adapterOptions?: Record<string, unknown> },
  ): Promise<void> {
    return this.backendApi.connectBackend(sessionId, options);
  }

  async disconnectBackend(sessionId: string): Promise<void> {
    return this.backendApi.disconnectBackend(sessionId);
  }

  isBackendConnected(sessionId: string): boolean {
    return this.backendApi.isBackendConnected(sessionId);
  }

  sendToBackend(sessionId: string, message: UnifiedMessage): void {
    this.runtimeApi.sendToBackend(sessionId, message);
  }
}
