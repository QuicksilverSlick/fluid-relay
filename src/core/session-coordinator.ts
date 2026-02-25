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
import type { BridgeEventMap, SessionCoordinatorEventMap } from "../types/events.js";
import type { SessionInfo, SessionSnapshot } from "../types/session-state.js";
import { noopLogger } from "../utils/noop-logger.js";
import { redactSecrets } from "../utils/redact-secrets.js";
import { BackendConnector } from "./backend/backend-connector.js";
import { CapabilitiesPolicy } from "./capabilities/capabilities-policy.js";
import { ConsumerBroadcaster, MAX_CONSUMER_MESSAGE_SIZE } from "./consumer/consumer-broadcaster.js";
import type { RateLimiterFactory } from "./consumer/consumer-gatekeeper.js";
import { ConsumerGatekeeper } from "./consumer/consumer-gatekeeper.js";
import { ConsumerGateway } from "./consumer/consumer-gateway.js";
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
  InboundCommand,
  PolicyCommand,
  SlashTraceContext,
} from "./interfaces/runtime-commands.js";
import type {
  IdleSessionReaper as IIdleSessionReaper,
  ReconnectController as IReconnectController,
} from "./interfaces/session-coordinator-coordination.js";
import type { SessionLauncher } from "./interfaces/session-launcher.js";
import type { SessionRegistry } from "./interfaces/session-registry.js";
import type { MessageTracer } from "./messaging/message-tracer.js";
import { noopTracer } from "./messaging/message-tracer.js";
import { generateSlashRequestId, generateTraceId } from "./messaging/message-tracing-utils.js";
import { IdlePolicy } from "./policies/idle-policy.js";
import { ReconnectPolicy } from "./policies/reconnect-policy.js";
import { GitInfoTracker } from "./session/git-info-tracker.js";
import { MessageQueueHandler } from "./session/message-queue-handler.js";
import type { SessionData } from "./session/session-data.js";
import type { SystemSignal } from "./session/session-event.js";
import {
  InMemorySessionLeaseCoordinator,
  type SessionLeaseCoordinator,
} from "./session/session-lease-coordinator.js";
import type { Session } from "./session/session-repository.js";
import { SessionRepository } from "./session/session-repository.js";
import type { SessionRuntime } from "./session/session-runtime.js";
import { SessionRuntime as SessionRuntimeImpl } from "./session/session-runtime.js";
import { SessionTransportHub } from "./session/session-transport-hub.js";
import {
  AdapterNativeHandler,
  LocalHandler,
  PassthroughHandler,
  SlashCommandChain,
  UnsupportedHandler,
} from "./slash/slash-command-chain.js";
import { SlashCommandExecutor } from "./slash/slash-command-executor.js";
import { SlashCommandRegistry } from "./slash/slash-command-registry.js";
import { SlashCommandService } from "./slash/slash-command-service.js";
import type { UnifiedMessage } from "./types/unified-message.js";

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
  leaseCoordinator?: SessionLeaseCoordinator;
  leaseOwnerId?: string;
}

export class SessionCoordinator extends TypedEventEmitter<SessionCoordinatorEventMap> {
  readonly launcher: SessionLauncher;
  readonly registry: SessionRegistry;
  readonly domainEvents: DomainEventBus;

  /** Plain EventEmitter for bridge events — forwarded to this coordinator emitter via CoordinatorEventRelay. */
  public readonly _bridgeEmitter: EventEmitter;

  // ── Services exposed for tests and e2e helpers ────────────────────────────
  public readonly store: SessionRepository;
  public readonly broadcaster: ConsumerBroadcaster;
  public readonly backendConnector: BackendConnector;

  // ── Private infra ─────────────────────────────────────────────────────────
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly leaseCoordinator: SessionLeaseCoordinator;
  private readonly leaseOwnerId: string;
  private readonly tracer: MessageTracer;
  private readonly gitResolver: GitInfoResolver | null;
  private readonly metrics: MetricsCollector | null;
  private adapterResolver: AdapterResolver | null;
  private _defaultAdapterName: string;
  private config: ResolvedConfig;
  private logger: Logger;

  // ── Private services (circular deps resolved via late-init) ───────────────
  private gitTracker!: GitInfoTracker;
  private capabilitiesPolicy!: CapabilitiesPolicy;
  private queueHandler!: MessageQueueHandler;
  private slashService!: SlashCommandService;
  private consumerGateway!: ConsumerGateway;

  // ── Coordinator sub-services ──────────────────────────────────────────────
  private transportHub: SessionTransportHub;
  private reconnectController: IReconnectController;
  private idleSessionReaper: IIdleSessionReaper;
  private processLogService = new ProcessLogService();
  private startupRestoreService: StartupRestoreService;
  private recoveryService: BackendRecoveryService;
  private relay: CoordinatorEventRelay;
  private started = false;

  // ── emitEvent: forwards to _bridgeEmitter, with lifecycle signal dispatch ──
  private readonly emitEvent = (type: string, payload: unknown): void => {
    if (
      payload &&
      typeof payload === "object" &&
      "sessionId" in payload &&
      type === "session:closed"
    ) {
      const sessionId = (payload as { sessionId?: unknown }).sessionId;
      if (typeof sessionId === "string") {
        const runtime = this.runtimes.get(sessionId);
        if (runtime) {
          runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "SESSION_CLOSED" } });
        }
      }
    }
    this._bridgeEmitter.emit(type, payload);
  };

  constructor(options: SessionCoordinatorOptions) {
    super();

    // ── Core config ─────────────────────────────────────────────────────────
    this.config = resolveConfig(options.config);
    this.logger = options.logger ?? noopLogger;
    this.adapterResolver = options.adapterResolver ?? null;
    this._defaultAdapterName = options.defaultAdapterName ?? "claude";
    this.domainEvents = new DomainEventBus();
    this.tracer = (options.tracer ?? noopTracer) as MessageTracer;
    this.gitResolver = options.gitResolver ?? null;
    this.metrics = options.metrics ?? null;
    this.leaseCoordinator = options.leaseCoordinator ?? new InMemorySessionLeaseCoordinator();
    this.leaseOwnerId = options.leaseOwnerId ?? `beamcode-${process.pid}-${randomUUID()}`;

    // ── Bridge event emitter ─────────────────────────────────────────────────
    this._bridgeEmitter = new EventEmitter();
    this._bridgeEmitter.setMaxListeners(100);

    // ── Session store ────────────────────────────────────────────────────────
    this.store = new SessionRepository(options.storage ?? null, {
      createRegistry: () => new SlashCommandRegistry(),
    });

    // ── Consumer plane ───────────────────────────────────────────────────────
    this.broadcaster = new ConsumerBroadcaster(
      this.logger,
      (sessionId: string, msg: unknown) =>
        this.emitEvent("message:outbound", { sessionId, message: msg }),
      this.tracer,
      (session: Session, ws: import("../interfaces/transport.js").WebSocketLike) =>
        this.getOrCreateRuntime(session).process({
          type: "SYSTEM_SIGNAL",
          signal: { kind: "CONSUMER_DISCONNECTED", ws },
        }),
      {
        getConsumerSockets: (session: Session) =>
          this.getOrCreateRuntime(session).getConsumerSockets(),
      },
    );

    const gatekeeper = new ConsumerGatekeeper(
      options.authenticator ?? null,
      this.config,
      options.rateLimiterFactory,
    );

    this.gitTracker = new GitInfoTracker(this.gitResolver, {
      getState: (session: Session) => this.getOrCreateRuntime(session).getState(),
      patchState: (session: Session, patch: Partial<SessionData["state"]>) =>
        this.getOrCreateRuntime(session).process({
          type: "SYSTEM_SIGNAL",
          signal: { kind: "STATE_PATCHED", patch },
        }),
    });

    // ── Message plane ────────────────────────────────────────────────────────
    this.capabilitiesPolicy = new CapabilitiesPolicy(this.config, this.logger, (session: Session) =>
      this.getOrCreateRuntime(session),
    );

    this.queueHandler = new MessageQueueHandler(
      (
        sessionId: string,
        content: string,
        opts?: { images?: { media_type: string; data: string }[] },
      ) => this.sendUserMessageForSession(sessionId, content, opts),
      (session: Session) => this.getOrCreateRuntime(session),
    );

    // ── Slash service ────────────────────────────────────────────────────────
    const processSignal = (session: Session, signal: SystemSignal) =>
      this.getOrCreateRuntime(session).process({ type: "SYSTEM_SIGNAL", signal });

    const localHandler = new LocalHandler({
      executor: new SlashCommandExecutor(),
      processSignal,
      tracer: this.tracer,
    });

    const commandChain = new SlashCommandChain([
      localHandler,
      new AdapterNativeHandler({ processSignal, tracer: this.tracer }),
      new PassthroughHandler({
        registerPendingPassthrough: (
          session: Session,
          entry: Session["pendingPassthroughs"][number],
        ) =>
          this.getOrCreateRuntime(session).process({
            type: "SYSTEM_SIGNAL",
            signal: { kind: "PASSTHROUGH_ENQUEUED", entry },
          }),
        sendUserMessage: (
          sessionId: string,
          content: string,
          trace?: { traceId: string; requestId: string; command: string },
        ) =>
          this.sendUserMessageForSession(sessionId, content, {
            traceContext: trace
              ? {
                  traceId: trace.traceId,
                  slashRequestId: trace.requestId,
                  slashCommand: trace.command,
                }
              : undefined,
          }),
        tracer: this.tracer,
      }),
      new UnsupportedHandler({ processSignal, tracer: this.tracer }),
    ]);

    this.slashService = new SlashCommandService({
      now: () => Date.now(),
      generateTraceId: () => generateTraceId(),
      generateSlashRequestId: () => generateSlashRequestId(),
      commandChain,
      localHandler,
    });

    // ── Backend connector ────────────────────────────────────────────────────
    this.backendConnector = new BackendConnector({
      adapter: options.adapter ?? null,
      adapterResolver: options.adapterResolver ?? null,
      logger: this.logger,
      metrics: this.metrics,
      routeUnifiedMessage: (session: Session, msg: UnifiedMessage) =>
        this.withMutableSession(session.id, "handleBackendMessage", (s) =>
          this.getOrCreateRuntime(s).process({ type: "BACKEND_MESSAGE", message: msg }),
        ),
      routeSystemSignal: (
        session: Session,
        signal: import("./session/session-event.js").SystemSignal,
      ) =>
        this.withMutableSession(session.id, "routeSystemSignal", (s) =>
          this.getOrCreateRuntime(s).process({ type: "SYSTEM_SIGNAL", signal }),
        ),
      emitEvent: this.emitEvent as (
        type: keyof BridgeEventMap,
        payload: BridgeEventMap[keyof BridgeEventMap],
      ) => void,
      getRuntime: (session: Session) => this.getOrCreateRuntime(session),
      tracer: this.tracer,
    });

    // ── Consumer gateway ─────────────────────────────────────────────────────
    this.consumerGateway = new ConsumerGateway({
      sessions: { get: (sessionId: string) => this.store.get(sessionId) },
      gatekeeper,
      broadcaster: this.broadcaster,
      gitTracker: this.gitTracker,
      logger: this.logger,
      metrics: this.metrics,
      emit: this.emitEvent as ConsumerGateway["deps"]["emit"],
      getRuntime: (session: Session) => this.getOrCreateRuntime(session),
      routeConsumerMessage: (
        session: Session,
        msg: InboundCommand,
        ws: import("../interfaces/transport.js").WebSocketLike,
      ) =>
        this.withMutableSession(session.id, "handleInboundCommand", (s) =>
          this.getOrCreateRuntime(s).process({ type: "INBOUND_COMMAND", command: msg, ws }),
        ),
      maxConsumerMessageSize: MAX_CONSUMER_MESSAGE_SIZE,
    });

    // ── Transport + policies ─────────────────────────────────────────────────
    this.launcher = options.launcher;
    this.registry = options.registry ?? options.launcher;

    // Structural adapters — the service sub-APIs satisfy the port interfaces
    // via structural typing, no explicit casts needed.
    const bridgeTransport = {
      handleConsumerOpen: (
        ws: import("../interfaces/transport.js").WebSocketLike,
        ctx: import("../interfaces/auth.js").AuthContext,
      ) => this.consumerGateway.handleConsumerOpen(ws, ctx),
      handleConsumerMessage: (
        ws: import("../interfaces/transport.js").WebSocketLike,
        sessionId: string,
        data: string | Buffer,
      ) => this.consumerGateway.handleConsumerMessage(ws, sessionId, data),
      handleConsumerClose: (
        ws: import("../interfaces/transport.js").WebSocketLike,
        sessionId: string,
      ) => this.consumerGateway.handleConsumerClose(ws, sessionId),
      setAdapterName: (sessionId: string, name: string) => this.setAdapterName(sessionId, name),
      connectBackend: (
        sessionId: string,
        opts?: { resume?: boolean; adapterOptions?: Record<string, unknown> },
      ) => this.connectBackendForSession(sessionId, opts),
    };

    const bridgeLifecycle = {
      getAllSessions: () => this.store.getAllStates(),
      getSession: (sessionId: string) => this.getSessionSnapshot(sessionId),
      closeSession: (sessionId: string) => this.closeSessionInternal(sessionId),
      applyPolicyCommand: (sessionId: string, command: PolicyCommand) =>
        this.applyPolicyCommandForSession(sessionId, command),
      broadcastWatchdogState: (
        sessionId: string,
        watchdog: { gracePeriodMs: number; startedAt: number } | null,
      ) => {
        const session = this.store.get(sessionId);
        if (session)
          this.getOrCreateRuntime(session).process({
            type: "SYSTEM_SIGNAL",
            signal: { kind: "WATCHDOG_STATE_CHANGED", watchdog },
          });
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

    // ── Extracted services (coordinator/) ────────────────────────────────────
    this.startupRestoreService = new StartupRestoreService({
      launcher: this.launcher,
      registry: this.registry,
      bridge: {
        restoreFromStorage: () => {
          const count = this.store.restoreAll();
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
          const session = this.store.get(sessionId);
          return session ? this.backendConnector.isBackendConnected(session) : false;
        },
        connectBackend: (sessionId, opts) => this.connectBackendForSession(sessionId, opts),
      },
      logger: this.logger,
      relaunchDedupMs: this.config.relaunchDedupMs,
      initializeTimeoutMs: this.config.initializeTimeoutMs,
      killGracePeriodMs: this.config.killGracePeriodMs,
    });

    // ── Event relay (coordinator/) ────────────────────────────────────────────
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
          const session = this.store.get(payload.sessionId);
          if (session)
            this.getOrCreateRuntime(session).process({
              type: "SYSTEM_SIGNAL",
              signal: { kind: "RESUME_FAILED", sessionId: payload.sessionId },
            });
        },
        onProcessStdout: (payload) => {
          this.handleProcessOutput(payload.sessionId, "stdout", payload.data);
        },
        onProcessStderr: (payload) => {
          this.handleProcessOutput(payload.sessionId, "stderr", payload.data);
        },
        onProcessExited: (payload) => {
          const session = this.store.get(payload.sessionId);
          if (session && payload.circuitBreaker) {
            this.getOrCreateRuntime(session).process({
              type: "SYSTEM_SIGNAL",
              signal: { kind: "CIRCUIT_BREAKER_CHANGED", circuitBreaker: payload.circuitBreaker },
            });
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
          this.applyPolicyCommandForSession(payload.sessionId, {
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
      void this.closeSessionInternal(sessionId);
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
    await this.closeAllSessions();
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
    await this.closeSessionInternal(sessionId);

    // Remove from registry's in-memory map and re-persist
    this.registry.removeSession(sessionId);

    return true;
  }

  /** Rename a session through the coordinator command path. */
  renameSession(sessionId: string, name: string): SessionInfo | null {
    const existing = this.registry.getSession(sessionId);
    if (!existing) return null;
    this.registry.setSessionName(sessionId, name);
    const session = this.store.get(sessionId);
    if (session) {
      this.getOrCreateRuntime(session).process({
        type: "SYSTEM_SIGNAL",
        signal: { kind: "SESSION_RENAMED", name },
      });
    }
    this._bridgeEmitter.emit("session:renamed", { sessionId, name });
    return { ...existing, name };
  }

  /** Execute a slash command programmatically. */
  async executeSlashCommand(
    sessionId: string,
    command: string,
  ): Promise<{ content: string; source: "emulated" } | null> {
    const session = this.store.get(sessionId);
    return session ? this.getOrCreateRuntime(session).executeSlashCommand(command) : null;
  }

  /** Get models reported by the CLI's initialize response. */
  getSupportedModels(sessionId: string): InitializeModel[] {
    return this.withSession(sessionId, [], (s) => this.getOrCreateRuntime(s).getSupportedModels());
  }

  /** Get commands reported by the CLI's initialize response. */
  getSupportedCommands(sessionId: string): InitializeCommand[] {
    return this.withSession(sessionId, [], (s) =>
      this.getOrCreateRuntime(s).getSupportedCommands(),
    );
  }

  /** Get account info reported by the CLI's initialize response. */
  getAccountInfo(sessionId: string): InitializeAccount | null {
    return this.withSession(sessionId, null, (s) => this.getOrCreateRuntime(s).getAccountInfo());
  }

  /** Returns whether a backend is connected for the given session. */
  isBackendConnected(sessionId: string): boolean {
    const session = this.store.get(sessionId);
    return session ? this.backendConnector.isBackendConnected(session) : false;
  }

  /** Seed the session's initial state (cwd, model). Public for test utilities. */
  seedSessionState(sessionId: string, params: { cwd?: string; model?: string }): void {
    const session = this.getOrCreateSession(sessionId);
    this.getOrCreateRuntime(session).process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "SESSION_SEEDED", cwd: params.cwd, model: params.model },
    });
  }

  /** Set the adapter name for the session. Public for test utilities. */
  setAdapterName(sessionId: string, name: string): void {
    const session = this.getOrCreateSession(sessionId);
    this.getOrCreateRuntime(session).process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "ADAPTER_NAME_SET", name },
    });
  }

  /** Get a session snapshot. Public for test utilities and e2e helpers. */
  getSessionSnapshot(sessionId: string): SessionSnapshot | undefined {
    const session = this.store.get(sessionId);
    if (!session) return undefined;
    return this.getOrCreateRuntime(session).getSessionSnapshot();
  }

  // ── Private: runtime management ──────────────────────────────────────────

  private getOrCreateRuntime(session: Session): SessionRuntime {
    let r = this.runtimes.get(session.id);
    if (!r) {
      r = new SessionRuntimeImpl(session, {
        config: { maxMessageHistoryLength: this.config.maxMessageHistoryLength },
        broadcaster: this.broadcaster,
        queueHandler: this.queueHandler,
        slashService: this.slashService,
        backendConnector: this.backendConnector,
        tracer: this.tracer,
        store: this.store,
        logger: this.logger,
        emitEvent: this.emitEvent,
        gitTracker: this.gitTracker,
        gitResolver: this.gitResolver,
        capabilitiesPolicy: this.capabilitiesPolicy,
      });
      this.runtimes.set(session.id, r);
    }
    return r;
  }

  // ── Private: session lifecycle ────────────────────────────────────────────

  private getOrCreateSession(sessionId: string): Session {
    if (!this.leaseCoordinator.ensureLease(sessionId, this.leaseOwnerId)) {
      this.logger.warn("Session lifecycle getOrCreate blocked: lease not owned by this runtime", {
        sessionId,
        leaseOwnerId: this.leaseOwnerId,
        currentLeaseOwner: this.leaseCoordinator.currentOwner(sessionId),
      });
      throw new Error(`Session lease for ${sessionId} is owned by another runtime`);
    }
    const existed = this.store.has(sessionId);
    const session = this.store.getOrCreate(sessionId);
    this.getOrCreateRuntime(session);
    if (!existed) {
      this.metrics?.recordEvent({
        timestamp: Date.now(),
        type: "session:created",
        sessionId,
      });
    }
    return session;
  }

  private async closeSessionInternal(sessionId: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session) return;
    const runtime = this.getOrCreateRuntime(session);
    runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "SESSION_CLOSING" } });
    if (runtime.getBackendSession()) {
      await runtime.closeBackendConnection().catch((err: unknown) => {
        this.logger.warn("Failed to close backend session", { sessionId, error: err });
      });
    }
    runtime.closeAllConsumers();
    runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "SESSION_CLOSED" } });
    this.store.remove(sessionId);
    this.runtimes.delete(sessionId);
    this.leaseCoordinator.releaseLease(sessionId, this.leaseOwnerId);
    this.metrics?.recordEvent({ timestamp: Date.now(), type: "session:closed", sessionId });
    this.emitEvent("session:closed", { sessionId });
  }

  private async closeAllSessions(): Promise<void> {
    for (const sessionId of [...this.runtimes.keys()]) {
      await this.closeSessionInternal(sessionId);
    }
    this.runtimes.clear();
    const storage = this.store.getStorage();
    if (storage?.flush) {
      try {
        await storage.flush();
      } catch (error) {
        this.logger.warn("Failed to flush storage during shutdown", { error });
      }
    }
    this.tracer.destroy();
    this.removeAllListeners();
  }

  // ── Private: session mutation helpers ─────────────────────────────────────

  private withSession<T>(sessionId: string, fallback: T, fn: (session: Session) => T): T {
    const session = this.store.get(sessionId);
    return session ? fn(session) : fallback;
  }

  private withMutableSession(sessionId: string, op: string, fn: (session: Session) => void): void {
    if (!this.leaseCoordinator.ensureLease(sessionId, this.leaseOwnerId)) {
      this.logger.warn(`Session mutation blocked: lease not owned by this runtime`, {
        sessionId,
        operation: op,
      });
      return;
    }
    const session = this.store.get(sessionId);
    if (session) fn(session);
  }

  // ── Private: runtimeApi operations ────────────────────────────────────────

  private sendUserMessageForSession(
    sessionId: string,
    text: string,
    options?: {
      traceContext?: SlashTraceContext;
      images?: { media_type: string; data: string }[];
    },
  ): void {
    this.withMutableSession(sessionId, "sendUserMessage", (s) =>
      this.getOrCreateRuntime(s).sendUserMessage(text, options),
    );
  }

  private applyPolicyCommandForSession(sessionId: string, command: PolicyCommand): void {
    this.withMutableSession(sessionId, "applyPolicyCommand", (s) => {
      const kindMap: Record<string, SystemSignal["kind"]> = {
        reconnect_timeout: "RECONNECT_TIMEOUT",
        idle_reap: "IDLE_REAP",
        capabilities_timeout: "CAPABILITIES_TIMEOUT",
      };
      const kind = kindMap[command.type];
      if (kind) {
        this.getOrCreateRuntime(s).process({
          type: "SYSTEM_SIGNAL",
          signal: { kind } as SystemSignal,
        });
      }
    });
  }

  // ── Private: coordinator helpers ──────────────────────────────────────────

  /** Delegates to ReconnectController. Kept as named method for E2E test access. */
  private startReconnectWatchdog(): void {
    this.reconnectController.start();
  }

  private handleProcessOutput(sessionId: string, stream: "stdout" | "stderr", data: string): void {
    const redacted = this.processLogService.append(sessionId, stream, data);
    const session = this.store.get(sessionId);
    if (session) {
      this.getOrCreateRuntime(session).process({
        type: "SYSTEM_SIGNAL",
        signal: { kind: "PROCESS_OUTPUT_RECEIVED", stream, data: redacted },
      });
    }
  }

  /** Resolve session by ID and connect to the backend adapter. */
  private async connectBackendForSession(
    sessionId: string,
    opts?: { resume?: boolean; adapterOptions?: Record<string, unknown> },
  ): Promise<void> {
    const session = this.getOrCreateSession(sessionId);
    return this.backendConnector.connectBackend(session, opts);
  }
}
