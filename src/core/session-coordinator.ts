/**
 * SessionCoordinator — top-level facade and entry point.
 *
 * Owns the session registry and wires the transport layer (SessionTransportHub,
 * session services), policy services (ReconnectPolicy, IdlePolicy), and the
 * DomainEventBus. Each accepted session gets one SessionRuntime. Consumers
 * and backends connect via the services; all session lifecycle events flow
 * through this class and are published to the bus for other subsystems to observe.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import type { Authenticator } from "../interfaces/auth.js";
import type { GitInfoResolver } from "../interfaces/git-resolver.js";
import type { Logger } from "../interfaces/logger.js";
import type { MetricsCollector } from "../interfaces/metrics.js";
import type { SessionStorage } from "../interfaces/storage.js";
import type { WebSocketServerLike } from "../interfaces/ws-server.js";
import type {
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
} from "../types/cli-messages.js";
import type { ProviderConfig, ResolvedConfig } from "../types/config.js";
import { resolveConfig } from "../types/config.js";
import type { SessionCoordinatorEventMap } from "../types/events.js";
import type { SessionInfo, SessionSnapshot } from "../types/session-state.js";
import { noopLogger } from "../utils/noop-logger.js";
import { redactSecrets } from "../utils/redact-secrets.js";
import { buildSessionServices } from "./build-session-services.js";
import type { RateLimiterFactory } from "./consumer/consumer-gatekeeper.js";
import { BackendRecoveryService } from "./coordinator/backend-recovery-service.js";
import { CoordinatorEventRelay } from "./coordinator/coordinator-event-relay.js";
import { ProcessLogService } from "./coordinator/process-log-service.js";
import { StartupRestoreService } from "./coordinator/startup-restore-service.js";
import { DomainEventBus } from "./events/domain-event-bus.js";
import { TypedEventEmitter } from "./events/typed-emitter.js";
import type { CliAdapterName } from "./interfaces/adapter-names.js";
import type { AdapterResolver } from "./interfaces/adapter-resolver.js";
import type { BackendAdapter } from "./interfaces/backend-adapter.js";
import { isInvertedConnectionAdapter } from "./interfaces/inverted-connection-adapter.js";
import type {
  IdleSessionReaper as IIdleSessionReaper,
  ReconnectController as IReconnectController,
} from "./interfaces/session-coordinator-coordination.js";
import type { SessionLauncher } from "./interfaces/session-launcher.js";
import type { SessionRegistry } from "./interfaces/session-registry.js";
import type { MessageTracer } from "./messaging/message-tracer.js";
import { IdlePolicy } from "./policies/idle-policy.js";
import { ReconnectPolicy } from "./policies/reconnect-policy.js";
import { SessionTransportHub } from "./session/session-transport-hub.js";
import type { SessionServices } from "./session-services.js";

/**
 * Facade wiring session services + SessionLauncher together.
 *
 * Auto-wires:
 * - backend:session_id → registry.setBackendSessionId
 * - backend:relaunch_needed → launcher.relaunch (with dedup — A5)
 * - backend:connected → registry.markConnected
 * - Reconnection watchdog (I4)
 * - Restore order: launcher before bridge (I6)
 */
export interface SessionCoordinatorOptions {
  config: ProviderConfig;
  storage?: SessionStorage;
  logger?: Logger;
  gitResolver?: GitInfoResolver;
  authenticator?: Authenticator;
  server?: WebSocketServerLike;
  metrics?: MetricsCollector;
  adapter?: BackendAdapter;
  adapterResolver?: AdapterResolver;
  launcher: SessionLauncher;
  registry?: SessionRegistry;
  rateLimiterFactory?: RateLimiterFactory;
  tracer?: MessageTracer;
  defaultAdapterName?: string;
}

/**
 * Minimal bridge-compatible facade exposed as `coordinator.bridge`.
 *
 * Provides the bridge methods referenced by E2E tests and test utilities
 * without requiring a full `SessionBridge` instance. The backing services
 * are injected at construction time.
 */
export interface BridgeFacade {
  // State queries
  isBackendConnected(sessionId: string): boolean;
  getSession(sessionId: string): SessionSnapshot | undefined;
  // Seeding
  seedSessionState(sessionId: string, params: { cwd?: string; model?: string }): void;
  setAdapterName(sessionId: string, name: string): void;
  // Broadcast
  broadcastProcessOutput(sessionId: string, stream: "stdout" | "stderr", data: string): void;
  broadcastNameUpdate(sessionId: string, name: string): void;
  // Session rename (broadcast + event emission)
  renameSession(sessionId: string, name: string): void;
  // Slash commands
  executeSlashCommand(
    sessionId: string,
    command: string,
  ): Promise<{ content: string; source: "emulated" } | null>;
  // Event subscriptions (EventSource interface)
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  // Event emission (allows tests to simulate bridge events)
  emit(event: string, ...args: unknown[]): void;
}

export class SessionCoordinator extends TypedEventEmitter<SessionCoordinatorEventMap> {
  /** Thin bridge-compatible facade for backward-compat access by E2E tests and test utils. */
  readonly bridge: BridgeFacade;
  readonly launcher: SessionLauncher;
  readonly registry: SessionRegistry;
  readonly domainEvents: DomainEventBus;

  private readonly services: SessionServices;
  /** Plain EventEmitter for bridge events — forwarded to this coordinator emitter via CoordinatorEventRelay. */
  private readonly _bridgeEmitter: EventEmitter;
  private adapterResolver: AdapterResolver | null;
  private _defaultAdapterName: string;
  private config: ResolvedConfig;
  private logger: Logger;
  private transportHub: SessionTransportHub;
  private reconnectController: IReconnectController;
  private idleSessionReaper: IIdleSessionReaper;
  private processLogService = new ProcessLogService();
  private startupRestoreService: StartupRestoreService;
  private recoveryService: BackendRecoveryService;
  private relay: CoordinatorEventRelay;
  private started = false;

  constructor(options: SessionCoordinatorOptions) {
    super();

    // ── Core config ─────────────────────────────────────────────────────
    this.config = resolveConfig(options.config);
    this.logger = options.logger ?? noopLogger;
    this.adapterResolver = options.adapterResolver ?? null;
    this._defaultAdapterName = options.defaultAdapterName ?? "claude";
    this.domainEvents = new DomainEventBus();

    // ── Bridge event emitter (replaces SessionBridge as event source) ────
    this._bridgeEmitter = new EventEmitter();
    this._bridgeEmitter.setMaxListeners(100);

    // ── Session services (message routing + runtime map) ─────────────────
    this.services = buildSessionServices(
      {
        storage: options.storage,
        gitResolver: options.gitResolver,
        authenticator: options.authenticator,
        logger: options.logger,
        config: options.config,
        metrics: options.metrics,
        adapter: options.adapter,
        adapterResolver: options.adapterResolver,
        rateLimiterFactory: options.rateLimiterFactory,
        tracer: options.tracer,
      },
      (type, payload) => this._bridgeEmitter.emit(type, payload),
    );

    // ── Bridge compat facade ─────────────────────────────────────────────
    // Use a local `bridge` so that `renameSession` can reference
    // `bridge.broadcastNameUpdate` and be intercepted by test spies.
    const bridge: BridgeFacade = {
      isBackendConnected: (sessionId) => {
        const session = this.services.store.get(sessionId);
        return session ? this.services.backendConnector.isBackendConnected(session) : false;
      },
      getSession: (sessionId) => this.getSessionSnapshot(sessionId),
      seedSessionState: (sessionId, params) => this.seedSessionState(sessionId, params),
      setAdapterName: (sessionId, name) => this.setAdapterName(sessionId, name),
      broadcastProcessOutput: (sessionId, stream, data) => {
        const session = this.services.store.get(sessionId);
        if (session) this.services.broadcaster.broadcastProcessOutput(session, stream, data);
      },
      broadcastNameUpdate: (sessionId, name) => {
        const session = this.services.store.get(sessionId);
        if (session) this.services.broadcaster.broadcastNameUpdate(session, name);
      },
      renameSession: (sessionId, name) => {
        bridge.broadcastNameUpdate(sessionId, name);
        this._bridgeEmitter.emit("session:renamed", { sessionId, name });
      },
      executeSlashCommand: (sessionId, command) =>
        this.services.runtimeApi.executeSlashCommand(sessionId, command),
      on: (event, listener) => this._bridgeEmitter.on(event, listener),
      off: (event, listener) => this._bridgeEmitter.off(event, listener),
      emit: (event, ...args) => {
        this._bridgeEmitter.emit(event, ...args);
      },
    };
    this.bridge = bridge;

    // ── Transport + policies ─────────────────────────────────────────────
    this.launcher = options.launcher;
    this.registry = options.registry ?? options.launcher;

    // Structural adapters — the service sub-APIs satisfy the port interfaces
    // via structural typing, no explicit casts needed.
    const bridgeTransport = {
      handleConsumerOpen: (
        ws: import("../interfaces/transport.js").WebSocketLike,
        ctx: import("../interfaces/auth.js").AuthContext,
      ) => this.services.consumerGateway.handleConsumerOpen(ws, ctx),
      handleConsumerMessage: (
        ws: import("../interfaces/transport.js").WebSocketLike,
        sessionId: string,
        data: string | Buffer,
      ) => this.services.consumerGateway.handleConsumerMessage(ws, sessionId, data),
      handleConsumerClose: (
        ws: import("../interfaces/transport.js").WebSocketLike,
        sessionId: string,
      ) => this.services.consumerGateway.handleConsumerClose(ws, sessionId),
      setAdapterName: (sessionId: string, name: string) => this.setAdapterName(sessionId, name),
      connectBackend: (
        sessionId: string,
        opts?: { resume?: boolean; adapterOptions?: Record<string, unknown> },
      ) => this.connectBackendForSession(sessionId, opts),
    };

    const bridgeLifecycle = {
      getAllSessions: () => this.services.store.getAllStates(),
      getSession: (sessionId: string) => this.getSessionSnapshot(sessionId),
      closeSession: (sessionId: string) => this.services.lifecycleService.closeSession(sessionId),
      applyPolicyCommand: (
        sessionId: string,
        command: import("./interfaces/runtime-commands.js").PolicyCommand,
      ) => this.services.runtimeApi.applyPolicyCommand(sessionId, command),
      broadcastWatchdogState: (
        sessionId: string,
        watchdog: { gracePeriodMs: number; startedAt: number } | null,
      ) => {
        const session = this.services.store.get(sessionId);
        if (session) this.services.broadcaster.broadcastWatchdogState(session, watchdog);
      },
    };

    this.transportHub = new SessionTransportHub({
      bridge: bridgeTransport,
      launcher: this.launcher,
      adapter: options.adapter ?? null,
      adapterResolver: options.adapterResolver ?? null,
      logger: this.logger,
      server: options.server ?? null,
      port: this.config.port,
      toAdapterSocket: (socket) => socket as unknown as WebSocket,
    });
    this.reconnectController = new ReconnectPolicy({
      launcher: this.launcher,
      bridge: bridgeLifecycle,
      logger: this.logger,
      reconnectGracePeriodMs: this.config.reconnectGracePeriodMs,
      domainEvents: this.domainEvents,
    });
    this.idleSessionReaper = new IdlePolicy({
      bridge: bridgeLifecycle,
      logger: this.logger,
      idleSessionTimeoutMs: this.config.idleSessionTimeoutMs,
      domainEvents: this.domainEvents,
    });

    // ── Extracted services (coordinator/) ────────────────────────────────
    this.startupRestoreService = new StartupRestoreService({
      launcher: this.launcher,
      registry: this.registry,
      bridge: {
        restoreFromStorage: () => {
          const count = this.services.store.restoreAll();
          if (count > 0) this.logger.info(`Restored ${count} session(s) from disk`);
          return count;
        },
      },
      logger: this.logger,
    });
    this.recoveryService = new BackendRecoveryService({
      launcher: this.launcher,
      registry: this.registry,
      bridge: {
        isBackendConnected: (sessionId) => {
          const session = this.services.store.get(sessionId);
          return session ? this.services.backendConnector.isBackendConnected(session) : false;
        },
        connectBackend: (sessionId, opts) => this.connectBackendForSession(sessionId, opts),
      },
      logger: this.logger,
      relaunchDedupMs: this.config.relaunchDedupMs,
      initializeTimeoutMs: this.config.initializeTimeoutMs,
      killGracePeriodMs: this.config.killGracePeriodMs,
    });

    // ── Event relay (coordinator/) ──────────────────────────────────────
    this.relay = new CoordinatorEventRelay({
      emit: (event, payload) =>
        // biome-ignore lint/suspicious/noExplicitAny: dynamic event forwarding
        this.emit(event as any, payload as any),
      domainEvents: this.domainEvents,
      bridge: this._bridgeEmitter,
      launcher: this.launcher,
      handlers: {
        onProcessSpawned: (payload) => {
          const { sessionId } = payload;
          const info = this.registry.getSession(sessionId);
          if (!info) return;
          this.seedSessionState(sessionId, {
            cwd: info.cwd,
            model: info.model,
          });
          this.setAdapterName(sessionId, info.adapterName ?? this.defaultAdapterName);
        },
        onBackendSessionId: (payload) => {
          this.registry.setBackendSessionId(payload.sessionId, payload.backendSessionId);
        },
        onBackendConnected: (payload) => {
          this.registry.markConnected(payload.sessionId);
        },
        onProcessResumeFailed: (payload) => {
          const session = this.services.store.get(payload.sessionId);
          if (session) this.services.broadcaster.broadcastResumeFailed(session, payload.sessionId);
        },
        onProcessStdout: (payload) => {
          this.handleProcessOutput(payload.sessionId, "stdout", payload.data);
        },
        onProcessStderr: (payload) => {
          this.handleProcessOutput(payload.sessionId, "stderr", payload.data);
        },
        onProcessExited: (payload) => {
          const session = this.services.store.get(payload.sessionId);
          if (session && payload.circuitBreaker) {
            this.services.broadcaster.broadcastCircuitBreakerState(session, payload.circuitBreaker);
          }
        },
        onFirstTurnCompleted: (payload) => {
          const { sessionId, firstUserMessage } = payload;
          const session = this.registry.getSession(sessionId);
          if (session?.name) return;
          let name = firstUserMessage.split("\n")[0].trim();
          name = redactSecrets(name);
          if (name.length > 50) name = `${name.slice(0, 47)}...`;
          if (!name) return;
          this.renameSession(sessionId, name);
        },
        onSessionClosed: (payload) => {
          this.processLogService.cleanup(payload.sessionId);
        },
        onCapabilitiesTimeout: (payload) => {
          this.services.runtimeApi.applyPolicyCommand(payload.sessionId, {
            type: "capabilities_timeout",
          });
        },
        onBackendRelaunchNeeded: (payload) => {
          void this.recoveryService.handleRelaunchNeeded(payload.sessionId);
        },
      },
    });
  }

  get defaultAdapterName(): string {
    return this.adapterResolver?.defaultName ?? this._defaultAdapterName;
  }

  /** Create a new session, routing to the correct adapter. */
  async createSession(options: {
    cwd?: string;
    model?: string;
    adapterName?: CliAdapterName;
  }): Promise<{
    sessionId: string;
    cwd: string;
    adapterName: CliAdapterName;
    state: string;
    createdAt: number;
  }> {
    const adapterName = options.adapterName ?? (this.defaultAdapterName as CliAdapterName);
    const cwd = options.cwd ?? process.cwd();

    // Inverted connection (e.g. Claude --sdk-url) or no resolver (legacy mode):
    // launcher spawns process, CLI connects back via WebSocket.
    const adapter = this.adapterResolver?.resolve(adapterName);
    if (!adapter || isInvertedConnectionAdapter(adapter)) {
      const launchResult = this.launcher.launch({ cwd, model: options.model });
      launchResult.adapterName = adapterName;
      this.seedSessionState(launchResult.sessionId, {
        cwd: launchResult.cwd,
        model: options.model,
      });
      this.setAdapterName(launchResult.sessionId, adapterName);
      return {
        sessionId: launchResult.sessionId,
        cwd: launchResult.cwd,
        adapterName,
        state: launchResult.state,
        createdAt: launchResult.createdAt,
      };
    }

    // Direct connection: connect via adapter
    const sessionId = randomUUID();
    const createdAt = Date.now();

    this.registry.register({
      sessionId,
      cwd,
      createdAt,
      model: options.model,
      adapterName,
    });

    this.seedSessionState(sessionId, { cwd, model: options.model });
    this.setAdapterName(sessionId, adapterName);

    try {
      await this.connectBackendForSession(sessionId, {
        adapterOptions: {
          cwd,
          initializeTimeoutMs: this.config.initializeTimeoutMs,
          killGracePeriodMs: this.config.killGracePeriodMs,
        },
      });
      this.registry.markConnected(sessionId);
    } catch (err) {
      this.registry.removeSession(sessionId);
      void this.services.lifecycleService.closeSession(sessionId);
      throw err;
    }

    return { sessionId, cwd, adapterName, state: "connected", createdAt };
  }

  /** Set the WebSocket server (allows deferred wiring after HTTP server is created). */
  setServer(server: WebSocketServerLike): void {
    this.transportHub.setServer(server);
  }

  /**
   * Start the session coordinator:
   * 1. Wire services + launcher events
   * 2. Restore from storage (launcher first, then services — I6)
   * 3. Start reconnection watchdog (I4)
   * 4. Start WebSocket server if provided
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.relay.start();
    this.startupRestoreService.restore();
    this.startReconnectWatchdog();
    this.idleSessionReaper.start();
    await this.transportHub.start();
  }

  /**
   * Graceful shutdown:
   * 1. Stop event relay and clear timers
   * 2. Stop transport hub
   * 3. Kill all CLI processes
   * 4. Close all sessions (sockets) and adapters
   */
  async stop(): Promise<void> {
    this.relay.stop();

    this.reconnectController.stop();
    this.idleSessionReaper.stop();
    this.recoveryService.stop();

    await this.transportHub.stop();

    await this.launcher.killAll();
    await this.closeSessions();
    await this.adapterResolver?.stopAll?.();
    this.started = false;
  }

  /**
   * Fully delete a session: kill CLI process, clean up dedup state,
   * close WS connections + remove persisted JSON, remove from registry.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const info = this.registry.getSession(sessionId);
    if (!info) return false;

    // Kill process if one exists (Claude sessions have PIDs, external sessions don't)
    if (info.pid) {
      await this.launcher.kill(sessionId);
    }

    // Clear relaunch dedup state
    this.recoveryService.clearDedupState(sessionId);

    // Close WS connections and remove per-session JSON from storage
    await this.services.lifecycleService.closeSession(sessionId);

    // Remove from registry's in-memory map and re-persist
    this.registry.removeSession(sessionId);

    return true;
  }

  /** Rename a session through the coordinator command path. */
  renameSession(sessionId: string, name: string): SessionInfo | null {
    const existing = this.registry.getSession(sessionId);
    if (!existing) return null;
    this.registry.setSessionName(sessionId, name);
    this.bridge.renameSession(sessionId, name);
    return { ...existing, name };
  }

  private handleProcessOutput(sessionId: string, stream: "stdout" | "stderr", data: string): void {
    const redacted = this.processLogService.append(sessionId, stream, data);
    this.bridge.broadcastProcessOutput(sessionId, stream, redacted);
  }

  /** Execute a slash command programmatically. */
  async executeSlashCommand(
    sessionId: string,
    command: string,
  ): Promise<{ content: string; source: "emulated" } | null> {
    return this.bridge.executeSlashCommand(sessionId, command);
  }

  /** Get models reported by the CLI's initialize response. */
  getSupportedModels(sessionId: string): InitializeModel[] {
    return this.services.runtimeApi.getSupportedModels(sessionId);
  }

  /** Get commands reported by the CLI's initialize response. */
  getSupportedCommands(sessionId: string): InitializeCommand[] {
    return this.services.runtimeApi.getSupportedCommands(sessionId);
  }

  /** Get account info reported by the CLI's initialize response. */
  getAccountInfo(sessionId: string): InitializeAccount | null {
    return this.services.runtimeApi.getAccountInfo(sessionId);
  }

  /** Delegates to ReconnectController. Kept as named method for E2E test access. */
  private startReconnectWatchdog(): void {
    this.reconnectController.start();
  }

  /** Close all sessions and flush storage (extracted from the old SessionBridge.close()). */
  private async closeSessions(): Promise<void> {
    await this.services.lifecycleService.closeAllSessions();
    const storage = this.services.store.getStorage();
    if (storage?.flush) {
      try {
        await storage.flush();
      } catch (error) {
        this.logger.warn("Failed to flush storage during shutdown", { error });
      }
    }
    this.services.core.tracer.destroy();
    this.removeAllListeners();
  }

  /** Resolve session by ID and connect to the backend adapter. */
  private async connectBackendForSession(
    sessionId: string,
    opts?: { resume?: boolean; adapterOptions?: Record<string, unknown> },
  ): Promise<void> {
    const session = this.services.lifecycleService.getOrCreateSession(sessionId);
    return this.services.backendConnector.connectBackend(session, opts);
  }

  // ── Inlined SessionInfoApi helpers ─────────────────────────────────────

  private getSessionSnapshot(sessionId: string): SessionSnapshot | undefined {
    const session = this.services.store.get(sessionId);
    if (!session) return undefined;
    return this.services.runtimeManager.getOrCreate(session).getSessionSnapshot();
  }

  private seedSessionState(sessionId: string, params: { cwd?: string; model?: string }): void {
    const session = this.services.lifecycleService.getOrCreateSession(sessionId);
    this.services.runtimeManager.getOrCreate(session).seedSessionState(params);
  }

  private setAdapterName(sessionId: string, name: string): void {
    const session = this.services.lifecycleService.getOrCreateSession(sessionId);
    this.services.runtimeManager.getOrCreate(session).setAdapterName(name);
  }
}
