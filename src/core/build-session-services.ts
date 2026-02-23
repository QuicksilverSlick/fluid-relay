/**
 * buildSessionServices — flat factory that assembles all session services.
 *
 * This is the single composition root for all session infrastructure.
 * All factory logic (runtime manager, slash service, deps, etc.) is inlined
 * here so `session-coordinator/` contains only this file plus the two
 * remaining service modules (RuntimeApi, SessionLifecycleService) that
 * require the Milestone 3 process()/Effect model to fully absorb.
 *
 * @module SessionControl
 */

import { randomUUID } from "node:crypto";
import type { Authenticator, ConsumerIdentity } from "../interfaces/auth.js";
import type { GitInfoResolver } from "../interfaces/git-resolver.js";
import type { Logger } from "../interfaces/logger.js";
import type { MetricsCollector } from "../interfaces/metrics.js";
import type { SessionStorage } from "../interfaces/storage.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import type { InitializeCommand } from "../types/cli-messages.js";
import type { ProviderConfig } from "../types/config.js";
import { resolveConfig } from "../types/config.js";
import type { BridgeEventMap } from "../types/events.js";
import { noopLogger } from "../utils/noop-logger.js";
import { BackendConnector, type BackendConnectorDeps } from "./backend/backend-connector.js";
import { CapabilitiesPolicy } from "./capabilities/capabilities-policy.js";
import { ConsumerBroadcaster, MAX_CONSUMER_MESSAGE_SIZE } from "./consumer/consumer-broadcaster.js";
import type { RateLimiterFactory } from "./consumer/consumer-gatekeeper.js";
import { ConsumerGatekeeper } from "./consumer/consumer-gatekeeper.js";
import { ConsumerGateway, type ConsumerGatewayDeps } from "./consumer/consumer-gateway.js";
import type { AdapterResolver } from "./interfaces/adapter-resolver.js";
import type { BackendAdapter, BackendSession } from "./interfaces/backend-adapter.js";
import type { InboundCommand } from "./interfaces/runtime-commands.js";
import type { MessageTracer } from "./messaging/message-tracer.js";
import { noopTracer } from "./messaging/message-tracer.js";
import {
  generateSlashRequestId,
  generateTraceId,
  tracedNormalizeInbound,
} from "./messaging/message-tracing-utils.js";
import { GitInfoTracker } from "./session/git-info-tracker.js";
import { MessageQueueHandler } from "./session/message-queue-handler.js";
import type { SessionData } from "./session/session-data.js";
import type { SystemSignal } from "./session/session-event.js";
import {
  InMemorySessionLeaseCoordinator,
  type SessionLeaseCoordinator,
} from "./session/session-lease-coordinator.js";
import type { LifecycleState } from "./session/session-lifecycle.js";
import type {
  Session,
  SessionRepository as SessionRepositoryType,
} from "./session/session-repository.js";
import { SessionRepository } from "./session/session-repository.js";
import type { SessionRuntime } from "./session/session-runtime.js";
import {
  type RuntimeTraceInfo,
  SessionRuntime as SessionRuntimeImpl,
} from "./session/session-runtime.js";
import type {
  LifecycleServiceFacade,
  RuntimeApiFacade,
  RuntimeManagerApi,
  SessionServices,
} from "./session-services.js";
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
import { TeamToolCorrelationBuffer } from "./team/team-tool-correlation.js";
import type { UnifiedMessage } from "./types/unified-message.js";

// ---------------------------------------------------------------------------
// Inlined: bridge-event-forwarder
// ---------------------------------------------------------------------------
type LifecycleSignal = "backend:connected" | "backend:disconnected" | "session:closed";

function isLifecycleSignal(type: string): type is LifecycleSignal {
  return (
    type === "backend:connected" || type === "backend:disconnected" || type === "session:closed"
  );
}

function forwardBridgeEventWithLifecycle(
  runtimeManager: RuntimeManagerApi,
  emit: (type: string, payload: unknown) => void,
  type: string,
  payload: unknown,
): void {
  if (payload && typeof payload === "object" && "sessionId" in payload && isLifecycleSignal(type)) {
    const sessionId = (payload as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === "string") {
      const runtime = runtimeManager.get(sessionId);
      if (runtime) {
        const signal: SystemSignal =
          type === "backend:connected"
            ? { kind: "BACKEND_CONNECTED" }
            : type === "backend:disconnected"
              ? { kind: "BACKEND_DISCONNECTED", reason: "bridge-event" }
              : { kind: "SESSION_CLOSED" };
        runtime.process({ type: "SYSTEM_SIGNAL", signal });
      }
    }
  }
  emit(type, payload);
}

// ---------------------------------------------------------------------------
// Inlined: runtime-manager-factory (createRuntimeManager)
// ---------------------------------------------------------------------------
export interface SessionRuntimeDeps {
  now: () => number;
  maxMessageHistoryLength: number;
  broadcaster: Pick<
    ConsumerBroadcaster,
    "broadcast" | "broadcastToParticipants" | "broadcastPresence" | "sendTo"
  >;
  queueHandler: Pick<
    MessageQueueHandler,
    | "handleQueueMessage"
    | "handleUpdateQueuedMessage"
    | "handleCancelQueuedMessage"
    | "autoSendQueuedMessage"
  >;
  slashService: Pick<SlashCommandService, "handleInbound" | "executeProgrammatic">;

  sendToBackend: (session: Session, message: UnifiedMessage) => void;
  tracedNormalizeInbound: (
    session: Session,
    msg: InboundCommand,
    trace?: RuntimeTraceInfo,
  ) => UnifiedMessage | null;
  persistSession: (session: Session) => void;
  warnUnknownPermission: (sessionId: string, requestId: string) => void;
  emitPermissionResolved: (
    sessionId: string,
    requestId: string,
    behavior: "allow" | "deny",
  ) => void;
  onSessionSeeded?: (session: Session) => void;
  onInvalidLifecycleTransition?: (params: {
    sessionId: string;
    from: LifecycleState;
    to: LifecycleState;
    reason: string;
  }) => void;
  canMutateSession?: (sessionId: string, operation: string) => boolean;
  onMutationRejected?: (sessionId: string, operation: string) => void;

  // Orchestration dependencies
  gitTracker: GitInfoTracker;
  gitResolver: GitInfoResolver | null;
  emitEvent: (type: string, payload: unknown) => void;
  capabilitiesPolicy: CapabilitiesPolicy;
}

interface RuntimeManagerFactoryDeps {
  now: SessionRuntimeDeps["now"];
  maxMessageHistoryLength: SessionRuntimeDeps["maxMessageHistoryLength"];
  getBroadcaster: () => SessionRuntimeDeps["broadcaster"];
  getQueueHandler: () => SessionRuntimeDeps["queueHandler"];
  getSlashService: () => SessionRuntimeDeps["slashService"];
  sendToBackend: SessionRuntimeDeps["sendToBackend"];
  tracedNormalizeInbound: SessionRuntimeDeps["tracedNormalizeInbound"];
  persistSession: SessionRuntimeDeps["persistSession"];
  warnUnknownPermission: SessionRuntimeDeps["warnUnknownPermission"];
  emitPermissionResolved: SessionRuntimeDeps["emitPermissionResolved"];
  onSessionSeeded: SessionRuntimeDeps["onSessionSeeded"];
  onInvalidLifecycleTransition: SessionRuntimeDeps["onInvalidLifecycleTransition"];
  canMutateSession?: SessionRuntimeDeps["canMutateSession"];
  onMutationRejected?: SessionRuntimeDeps["onMutationRejected"];
  emitEvent: SessionRuntimeDeps["emitEvent"];
  getGitTracker: () => SessionRuntimeDeps["gitTracker"];
  gitResolver: SessionRuntimeDeps["gitResolver"];
  getCapabilitiesPolicy: () => SessionRuntimeDeps["capabilitiesPolicy"];
}

function createRuntimeManager(deps: RuntimeManagerFactoryDeps): RuntimeManagerApi {
  const runtimes = new Map<string, SessionRuntime>();
  return {
    getOrCreate: (session: Session) => {
      let r = runtimes.get(session.id);
      if (!r) {
        r = new SessionRuntimeImpl(session, {
          now: deps.now,
          maxMessageHistoryLength: deps.maxMessageHistoryLength,
          broadcaster: deps.getBroadcaster(),
          queueHandler: deps.getQueueHandler(),
          slashService: deps.getSlashService(),
          sendToBackend: deps.sendToBackend,
          tracedNormalizeInbound: deps.tracedNormalizeInbound,
          persistSession: deps.persistSession,
          warnUnknownPermission: deps.warnUnknownPermission,
          emitPermissionResolved: deps.emitPermissionResolved,
          onSessionSeeded: deps.onSessionSeeded,
          onInvalidLifecycleTransition: deps.onInvalidLifecycleTransition,
          canMutateSession: deps.canMutateSession,
          onMutationRejected: deps.onMutationRejected,
          emitEvent: deps.emitEvent,
          gitTracker: deps.getGitTracker(),
          gitResolver: deps.gitResolver,
          capabilitiesPolicy: deps.getCapabilitiesPolicy(),
        });
        runtimes.set(session.id, r);
      }
      return r;
    },
    get: (sessionId: string) => runtimes.get(sessionId),
    has: (sessionId: string) => runtimes.has(sessionId),
    delete: (sessionId: string) => runtimes.delete(sessionId),
    clear: () => runtimes.clear(),
    keys: () => runtimes.keys(),
    getLifecycleState: (sessionId: string) => runtimes.get(sessionId)?.getLifecycleState(),
  };
}

// ---------------------------------------------------------------------------
// Inlined: session-deps-factory
// ---------------------------------------------------------------------------
type EmitBridgeEvent = (
  type: keyof BridgeEventMap,
  payload: BridgeEventMap[keyof BridgeEventMap],
) => void;

type CapabilitiesPolicyStateAccessors = {
  getState: (session: Session) => SessionData["state"];
  setState: (session: Session, state: SessionData["state"]) => void;
  getPendingInitialize: (session: Session) => Session["pendingInitialize"];
  setPendingInitialize: (session: Session, pendingInitialize: Session["pendingInitialize"]) => void;
  trySendRawToBackend: (session: Session, ndjson: string) => "sent" | "unsupported" | "no_backend";
  registerCLICommands: (session: Session, commands: InitializeCommand[]) => void;
};

type QueueStateAccessors = {
  getLastStatus: (session: Session) => SessionData["lastStatus"];
  setLastStatus: (session: Session, status: SessionData["lastStatus"]) => void;
  getQueuedMessage: (session: Session) => SessionData["queuedMessage"];
  setQueuedMessage: (session: Session, queued: SessionData["queuedMessage"]) => void;
  getConsumerIdentity: (session: Session, ws: WebSocketLike) => ConsumerIdentity | undefined;
};

type ConsumerPlaneRuntimeAccessors = {
  removeConsumer: (session: Session, ws: WebSocketLike) => ConsumerIdentity | undefined;
  getConsumerSockets: (
    session: Session,
  ) => ReadonlyMap<WebSocketLike, ConsumerIdentity> | Map<WebSocketLike, ConsumerIdentity>;
  getState: (session: Session) => SessionData["state"];
  setState: (session: Session, state: SessionData["state"]) => void;
  allocateAnonymousIdentityIndex: (session: Session) => number;
  checkRateLimit: (
    session: Session,
    ws: WebSocketLike,
    createLimiter: Parameters<SessionRuntime["checkRateLimit"]>[1],
  ) => boolean;
  getConsumerIdentity: (session: Session, ws: WebSocketLike) => ConsumerIdentity | undefined;
  getConsumerCount: (session: Session) => number;
  getMessageHistory: (session: Session) => SessionData["messageHistory"];
  getPendingPermissions: (session: Session) => ReturnType<SessionRuntime["getPendingPermissions"]>;
  getQueuedMessage: (session: Session) => SessionData["queuedMessage"];
  isBackendConnected: (session: Session) => boolean;
  addConsumer: (session: Session, ws: WebSocketLike, identity: ConsumerIdentity) => void;
};

function createCapabilitiesPolicyStateAccessors(
  runtime: (session: Session) => SessionRuntime,
): CapabilitiesPolicyStateAccessors {
  return {
    getState: (session: Session) => runtime(session).getState(),
    setState: (session: Session, state: SessionData["state"]) => runtime(session).setState(state),
    getPendingInitialize: (session: Session) => runtime(session).getPendingInitialize(),
    setPendingInitialize: (session: Session, pendingInitialize: Session["pendingInitialize"]) =>
      runtime(session).setPendingInitialize(pendingInitialize),
    trySendRawToBackend: (session: Session, ndjson: string) =>
      runtime(session).trySendRawToBackend(ndjson),
    registerCLICommands: (session: Session, commands: InitializeCommand[]) =>
      runtime(session).registerCLICommands(commands),
  };
}

function createQueueStateAccessors(
  runtime: (session: Session) => SessionRuntime,
  onQueuedMessageSet?: (session: Session) => void,
): QueueStateAccessors {
  return {
    getLastStatus: (session: Session) => runtime(session).getLastStatus(),
    setLastStatus: (session: Session, status: SessionData["lastStatus"]) =>
      runtime(session).setLastStatus(status),
    getQueuedMessage: (session: Session) => runtime(session).getQueuedMessage(),
    setQueuedMessage: (session: Session, queued: SessionData["queuedMessage"]) => {
      runtime(session).setQueuedMessage(queued);
      onQueuedMessageSet?.(session);
    },
    getConsumerIdentity: (session: Session, ws: WebSocketLike) =>
      runtime(session).getConsumerIdentity(ws),
  };
}

function createConsumerPlaneRuntimeAccessors(
  runtime: (session: Session) => SessionRuntime,
): ConsumerPlaneRuntimeAccessors {
  return {
    removeConsumer: (session: Session, ws: WebSocketLike) => runtime(session).removeConsumer(ws),
    getConsumerSockets: (session: Session) => runtime(session).getConsumerSockets(),
    getState: (session: Session) => runtime(session).getState(),
    setState: (session: Session, state: SessionData["state"]) => runtime(session).setState(state),
    allocateAnonymousIdentityIndex: (session: Session) =>
      runtime(session).allocateAnonymousIdentityIndex(),
    checkRateLimit: (session: Session, ws: WebSocketLike, createLimiter) =>
      runtime(session).checkRateLimit(ws, createLimiter),
    getConsumerIdentity: (session: Session, ws: WebSocketLike) =>
      runtime(session).getConsumerIdentity(ws),
    getConsumerCount: (session: Session) => runtime(session).getConsumerCount(),
    getMessageHistory: (session: Session) => runtime(session).getMessageHistory(),
    getPendingPermissions: (session: Session) => runtime(session).getPendingPermissions(),
    getQueuedMessage: (session: Session) => runtime(session).getQueuedMessage(),
    isBackendConnected: (session: Session) => runtime(session).isBackendConnected(),
    addConsumer: (session: Session, ws: WebSocketLike, identity: ConsumerIdentity) =>
      runtime(session).addConsumer(ws, identity),
  };
}

function createBackendConnectorDeps(params: {
  adapter: BackendAdapter | null;
  adapterResolver: AdapterResolver | null;
  logger: Logger;
  metrics: MetricsCollector | null;
  broadcaster: ConsumerBroadcaster;
  routeUnifiedMessage: (session: Session, msg: UnifiedMessage) => void;
  emitEvent: EmitBridgeEvent;
  runtime: (session: Session) => SessionRuntime;
  tracer: MessageTracer;
}): BackendConnectorDeps {
  return {
    adapter: params.adapter,
    adapterResolver: params.adapterResolver,
    logger: params.logger,
    metrics: params.metrics,
    broadcaster: params.broadcaster,
    routeUnifiedMessage: params.routeUnifiedMessage,
    emitEvent: params.emitEvent,
    onBackendConnectedState: (
      session: Session,
      connectedParams: {
        backendSession: BackendSession;
        backendAbort: AbortController;
        supportsSlashPassthrough: boolean;
        slashExecutor: Session["adapterSlashExecutor"] | null;
      },
    ) => params.runtime(session).attachBackendConnection(connectedParams),
    onBackendDisconnectedState: (session: Session) =>
      params.runtime(session).resetBackendConnectionState(),
    getBackendSession: (session: Session) => params.runtime(session).getBackendSession(),
    getBackendAbort: (session: Session) => params.runtime(session).getBackendAbort(),
    drainPendingMessages: (session: Session) => params.runtime(session).drainPendingMessages(),
    drainPendingPermissionIds: (session: Session) =>
      params.runtime(session).drainPendingPermissionIds(),
    peekPendingPassthrough: (session: Session) => params.runtime(session).peekPendingPassthrough(),
    shiftPendingPassthrough: (session: Session) =>
      params.runtime(session).shiftPendingPassthrough(),
    setSlashCommandsState: (session: Session, commands: string[]) => {
      const runtime = params.runtime(session);
      runtime.setState({ ...runtime.getState(), slash_commands: commands });
    },
    registerCLICommands: (session: Session, commands: string[]) =>
      params.runtime(session).registerSlashCommandNames(commands),
    tracer: params.tracer,
  };
}

function createConsumerGatewayDeps(params: {
  store: SessionRepositoryType;
  gatekeeper: ConsumerGatekeeper;
  broadcaster: ConsumerBroadcaster;
  gitTracker: GitInfoTracker;
  logger: Logger;
  metrics: MetricsCollector | null;
  emit: ConsumerGatewayDeps["emit"];
  routeConsumerMessage: (session: Session, msg: InboundCommand, ws: WebSocketLike) => void;
  maxConsumerMessageSize: number;
  tracer: MessageTracer;
  runtimeAccessors: ConsumerPlaneRuntimeAccessors;
}): ConsumerGatewayDeps {
  return {
    sessions: { get: (sessionId: string) => params.store.get(sessionId) },
    gatekeeper: params.gatekeeper,
    broadcaster: params.broadcaster,
    gitTracker: params.gitTracker,
    logger: params.logger,
    metrics: params.metrics,
    emit: params.emit,
    allocateAnonymousIdentityIndex: (session: Session) =>
      params.runtimeAccessors.allocateAnonymousIdentityIndex(session),
    checkRateLimit: (session: Session, ws: WebSocketLike) =>
      params.runtimeAccessors.checkRateLimit(session, ws, () =>
        params.gatekeeper.createRateLimiter(),
      ),
    getConsumerIdentity: (session: Session, ws: WebSocketLike) =>
      params.runtimeAccessors.getConsumerIdentity(session, ws),
    getConsumerCount: (session: Session) => params.runtimeAccessors.getConsumerCount(session),
    getState: (session: Session) => params.runtimeAccessors.getState(session),
    getMessageHistory: (session: Session) => params.runtimeAccessors.getMessageHistory(session),
    getPendingPermissions: (session: Session) =>
      params.runtimeAccessors.getPendingPermissions(session),
    getQueuedMessage: (session: Session) => params.runtimeAccessors.getQueuedMessage(session),
    isBackendConnected: (session: Session) => params.runtimeAccessors.isBackendConnected(session),
    registerConsumer: (session: Session, ws: WebSocketLike, identity: ConsumerIdentity) =>
      params.runtimeAccessors.addConsumer(session, ws, identity),
    unregisterConsumer: (session: Session, ws: WebSocketLike) =>
      params.runtimeAccessors.removeConsumer(session, ws),
    routeConsumerMessage: params.routeConsumerMessage,
    maxConsumerMessageSize: params.maxConsumerMessageSize,
    tracer: params.tracer,
  };
}

// ---------------------------------------------------------------------------
// Inlined: slash-service-factory (createSlashService)
// ---------------------------------------------------------------------------
type SlashEmitEvent = (
  type: keyof BridgeEventMap,
  payload: BridgeEventMap[keyof BridgeEventMap],
) => void;

type PassthroughDeps = ConstructorParameters<typeof PassthroughHandler>[0];

function createSlashService(params: {
  broadcaster: ConsumerBroadcaster;
  emitEvent: SlashEmitEvent;
  tracer: MessageTracer;
  now: () => number;
  generateTraceId: () => string;
  generateSlashRequestId: () => string;
  registerPendingPassthrough: PassthroughDeps["registerPendingPassthrough"];
  sendUserMessage: PassthroughDeps["sendUserMessage"];
}): SlashCommandService {
  const localHandler = new LocalHandler({
    executor: new SlashCommandExecutor(),
    broadcaster: params.broadcaster,
    emitEvent: params.emitEvent,
    tracer: params.tracer,
  });

  const commandChain = new SlashCommandChain([
    localHandler,
    new AdapterNativeHandler({
      broadcaster: params.broadcaster,
      emitEvent: params.emitEvent,
      tracer: params.tracer,
    }),
    new PassthroughHandler({
      broadcaster: params.broadcaster,
      emitEvent: params.emitEvent,
      registerPendingPassthrough: params.registerPendingPassthrough,
      sendUserMessage: params.sendUserMessage,
      tracer: params.tracer,
    }),
    new UnsupportedHandler({
      broadcaster: params.broadcaster,
      emitEvent: params.emitEvent,
      tracer: params.tracer,
    }),
  ]);

  return new SlashCommandService({
    tracer: params.tracer,
    now: params.now,
    generateTraceId: params.generateTraceId,
    generateSlashRequestId: params.generateSlashRequestId,
    commandChain,
    localHandler,
  });
}

// ---------------------------------------------------------------------------
// buildSessionServices
// ---------------------------------------------------------------------------

/** All options accepted by buildSessionServices (formerly SessionBridgeInitOptions). */
export type SessionBridgeInitOptions = {
  storage?: SessionStorage;
  gitResolver?: GitInfoResolver;
  authenticator?: Authenticator;
  logger?: Logger;
  config?: ProviderConfig;
  metrics?: MetricsCollector;
  adapter?: BackendAdapter;
  adapterResolver?: AdapterResolver;
  rateLimiterFactory?: RateLimiterFactory;
  tracer?: MessageTracer;
  leaseCoordinator?: SessionLeaseCoordinator;
  leaseOwnerId?: string;
};

/**
 * Assemble all session services into a flat SessionServices object.
 *
 * @param options - Init options forwarded from SessionCoordinator
 * @param emit - Raw bridge-event emitter (typically a TypedEventEmitter.emit)
 */
export function buildSessionServices(
  options: SessionBridgeInitOptions | undefined,
  emit: (type: string, payload: unknown) => void,
): SessionServices {
  // ── Core infra ────────────────────────────────────────────────────────────
  const logger = options?.logger ?? noopLogger;
  const config = resolveConfig(options?.config ?? { port: 9414 });
  const tracer = (options?.tracer ?? noopTracer) as MessageTracer;
  const gitResolver = options?.gitResolver ?? null;
  const metrics = options?.metrics ?? null;
  const leaseCoordinator = options?.leaseCoordinator ?? new InMemorySessionLeaseCoordinator();
  const leaseOwnerId = options?.leaseOwnerId ?? `beamcode-${process.pid}-${randomUUID()}`;

  // ── Session repository ────────────────────────────────────────────────────
  const store = new SessionRepository(options?.storage ?? null, {
    createCorrelationBuffer: () => new TeamToolCorrelationBuffer(),
    createRegistry: () => new SlashCommandRegistry(),
  });

  // ── Lazy refs for circular dependency resolution ───────────────────────────
  // Each lazy getter is only called AFTER all services are constructed.
  let runtimeManager!: RuntimeManagerApi;
  let broadcaster!: ConsumerBroadcaster;
  let queueHandler!: MessageQueueHandler;
  let slashService!: SlashCommandService;
  let backendConnector!: BackendConnector;
  let gitTracker!: GitInfoTracker;
  let capabilitiesPolicy!: CapabilitiesPolicy;

  // ── emitEvent ─────────────────────────────────────────────────────────────
  const emitEvent = (type: string, payload: unknown) =>
    forwardBridgeEventWithLifecycle(runtimeManager, emit, type, payload);

  // ── Runtime manager ───────────────────────────────────────────────────────
  runtimeManager = createRuntimeManager({
    now: () => Date.now(),
    maxMessageHistoryLength: config.maxMessageHistoryLength,
    getBroadcaster: () => broadcaster,
    getQueueHandler: () => queueHandler,
    getSlashService: () => slashService,
    sendToBackend: (runtimeSession: Session, message: UnifiedMessage) =>
      backendConnector.sendToBackend(runtimeSession, message),
    tracedNormalizeInbound: (
      runtimeSession: Session,
      inbound: InboundCommand,
      trace?: RuntimeTraceInfo,
    ) => tracedNormalizeInbound(tracer, inbound, runtimeSession.id, trace),
    persistSession: (runtimeSession: Session) => store.persist(runtimeSession),
    warnUnknownPermission: (sessionId: string, requestId: string) =>
      logger.warn(
        `Permission response for unknown request_id ${requestId} in session ${sessionId}`,
      ),
    emitPermissionResolved: (sessionId: string, requestId: string, behavior: "allow" | "deny") =>
      emit("permission:resolved", { sessionId, requestId, behavior }),
    onSessionSeeded: (runtimeSession: Session) => gitTracker.resolveGitInfo(runtimeSession),
    onInvalidLifecycleTransition: ({
      sessionId,
      from,
      to,
      reason,
    }: {
      sessionId: string;
      from: string;
      to: string;
      reason: string;
    }) =>
      logger.warn("Session lifecycle invalid transition", {
        sessionId,
        current: from,
        next: to,
        reason,
      }),
    canMutateSession: (sessionId: string) => leaseCoordinator.ensureLease(sessionId, leaseOwnerId),
    onMutationRejected: (sessionId: string, operation: string) =>
      logger.warn(`Mutation rejected for session ${sessionId}: ${operation}`),
    emitEvent,
    getGitTracker: () => gitTracker,
    gitResolver,
    getCapabilitiesPolicy: () => capabilitiesPolicy,
  });

  const withSession = <T>(sessionId: string, fallback: T, fn: (session: Session) => T): T => {
    const session = store.get(sessionId);
    return session ? fn(session) : fallback;
  };

  const withMutableSessionVoid = (
    sessionId: string,
    op: string,
    fn: (session: Session) => void,
  ) => {
    if (!leaseCoordinator.ensureLease(sessionId, leaseOwnerId)) {
      logger.warn(`Session mutation blocked: lease not owned by this runtime`, {
        sessionId,
        operation: op,
      });
      return;
    }
    const session = store.get(sessionId);
    if (session) fn(session);
  };

  const runtimeApi: RuntimeApiFacade = {
    sendUserMessage: (
      sessionId: string,
      text: string,
      options?: Parameters<RuntimeApiFacade["sendUserMessage"]>[2],
    ) =>
      withMutableSessionVoid(sessionId, "sendUserMessage", (s: Session) =>
        runtimeManager.getOrCreate(s).sendUserMessage(text, options),
      ),
    executeSlashCommand: async (sessionId: string, command: string) => {
      const session = store.get(sessionId);
      return session ? runtimeManager.getOrCreate(session).executeSlashCommand(command) : null;
    },
    applyPolicyCommand: (
      sessionId: string,
      command: Parameters<RuntimeApiFacade["applyPolicyCommand"]>[1],
    ) =>
      withMutableSessionVoid(sessionId, "applyPolicyCommand", (s: Session) => {
        const kindMap: Record<string, SystemSignal["kind"]> = {
          reconnect_timeout: "RECONNECT_TIMEOUT",
          idle_reap: "IDLE_REAP",
          capabilities_timeout: "CAPABILITIES_TIMEOUT",
        };
        const kind = kindMap[command.type];
        if (kind) {
          runtimeManager
            .getOrCreate(s)
            .process({ type: "SYSTEM_SIGNAL", signal: { kind } as SystemSignal });
        }
      }),
    handleBackendMessage: (sessionId: string, message: UnifiedMessage) =>
      withMutableSessionVoid(sessionId, "handleBackendMessage", (s: Session) =>
        runtimeManager.getOrCreate(s).process({ type: "BACKEND_MESSAGE", message }),
      ),
    handleInboundCommand: (sessionId: string, command: InboundCommand, ws: WebSocketLike) =>
      withMutableSessionVoid(sessionId, "handleInboundCommand", (s: Session) =>
        runtimeManager.getOrCreate(s).process({ type: "INBOUND_COMMAND", command, ws }),
      ),
    handleLifecycleSignal: (
      sessionId: string,
      signal: "backend:connected" | "backend:disconnected" | "session:closed",
    ) =>
      withMutableSessionVoid(sessionId, "handleLifecycleSignal", (s: Session) => {
        const kindMap = {
          "backend:connected": "BACKEND_CONNECTED",
          "backend:disconnected": "BACKEND_DISCONNECTED",
          "session:closed": "SESSION_CLOSED",
        } as const;
        runtimeManager
          .getOrCreate(s)
          .process({ type: "SYSTEM_SIGNAL", signal: { kind: kindMap[signal] } as SystemSignal });
      }),
    sendInterrupt: (sessionId: string) =>
      withMutableSessionVoid(sessionId, "sendInterrupt", (s: Session) =>
        runtimeManager.getOrCreate(s).sendInterrupt(),
      ),
    sendSetModel: (sessionId: string, model: string) =>
      withMutableSessionVoid(sessionId, "sendSetModel", (s: Session) =>
        runtimeManager.getOrCreate(s).sendSetModel(model),
      ),
    sendSetPermissionMode: (sessionId: string, mode: string) =>
      withMutableSessionVoid(sessionId, "sendSetPermissionMode", (s: Session) =>
        runtimeManager.getOrCreate(s).sendSetPermissionMode(mode),
      ),
    sendPermissionResponse: (
      sessionId: string,
      requestId: string,
      behavior: "allow" | "deny",
      options?: Parameters<RuntimeApiFacade["sendPermissionResponse"]>[3],
    ) =>
      withMutableSessionVoid(sessionId, "sendPermissionResponse", (s: Session) =>
        runtimeManager.getOrCreate(s).sendPermissionResponse(requestId, behavior, options),
      ),
    getSupportedModels: (sessionId: string) =>
      withSession(sessionId, [], (s: Session) =>
        runtimeManager.getOrCreate(s).getSupportedModels(),
      ),
    getSupportedCommands: (sessionId: string) =>
      withSession(sessionId, [], (s: Session) =>
        runtimeManager.getOrCreate(s).getSupportedCommands(),
      ),
    getAccountInfo: (sessionId: string) =>
      withSession(sessionId, null, (s: Session) => runtimeManager.getOrCreate(s).getAccountInfo()),
    sendToBackend: (sessionId: string, message: UnifiedMessage) => {
      const session = store.get(sessionId);
      if (!session) {
        logger.warn(`No backend session for ${sessionId}, cannot send message`);
        return;
      }
      withMutableSessionVoid(sessionId, "sendToBackend", (s: Session) =>
        runtimeManager.getOrCreate(s).sendToBackend(message),
      );
    },
  };

  // ── Consumer plane ────────────────────────────────────────────────────────
  const runtimeAccessors = createConsumerPlaneRuntimeAccessors((session: Session) =>
    runtimeManager.getOrCreate(session),
  );
  broadcaster = new ConsumerBroadcaster(
    logger,
    (sessionId: string, msg: unknown) => emitEvent("message:outbound", { sessionId, message: msg }),
    tracer,
    (session: Session, ws: WebSocketLike) => runtimeAccessors.removeConsumer(session, ws),
    {
      getConsumerSockets: (session: Session) => runtimeAccessors.getConsumerSockets(session),
    },
  );
  const gatekeeper = new ConsumerGatekeeper(
    options?.authenticator ?? null,
    config,
    options?.rateLimiterFactory,
  );
  gitTracker = new GitInfoTracker(gitResolver, {
    getState: (session: Session) => runtimeAccessors.getState(session),
    setState: (session: Session, state: SessionData["state"]) =>
      runtimeAccessors.setState(session, state),
  });

  // ── Message plane ─────────────────────────────────────────────────────────
  capabilitiesPolicy = new CapabilitiesPolicy(
    config,
    logger,
    broadcaster,
    emitEvent,
    createCapabilitiesPolicyStateAccessors((session: Session) =>
      runtimeManager.getOrCreate(session),
    ),
  );
  queueHandler = new MessageQueueHandler(
    broadcaster,
    (
      sessionId: string,
      content: string,
      opts?: Parameters<RuntimeApiFacade["sendUserMessage"]>[2],
    ) => runtimeApi.sendUserMessage(sessionId, content, opts),
    createQueueStateAccessors(
      (session: Session) => runtimeManager.getOrCreate(session),
      (session: Session) => store.persistSync(session),
    ),
  );
  const lifecycleService: LifecycleServiceFacade = {
    getOrCreateSession: (sessionId: string) => {
      if (!leaseCoordinator.ensureLease(sessionId, leaseOwnerId)) {
        logger.warn("Session lifecycle getOrCreate blocked: lease not owned by this runtime", {
          sessionId,
          leaseOwnerId,
          currentLeaseOwner: leaseCoordinator.currentOwner(sessionId),
        });
        throw new Error(`Session lease for ${sessionId} is owned by another runtime`);
      }
      const existed = store.has(sessionId);
      const session = store.getOrCreate(sessionId);
      runtimeManager.getOrCreate(session);
      if (!existed) {
        metrics?.recordEvent({ timestamp: Date.now(), type: "session:created", sessionId });
      }
      return session;
    },
    removeSession: (sessionId: string) => {
      const session = store.get(sessionId);
      if (session) capabilitiesPolicy.cancelPendingInitialize(session);
      runtimeManager.delete(sessionId);
      store.remove(sessionId);
      leaseCoordinator.releaseLease(sessionId, leaseOwnerId);
    },
    closeSession: async (sessionId: string) => {
      const session = store.get(sessionId);
      if (!session) return;
      const runtime = runtimeManager.getOrCreate(session);
      runtime.transitionLifecycle("closing", "session:close");
      capabilitiesPolicy.cancelPendingInitialize(session);
      if (runtime.getBackendSession()) {
        await runtime.closeBackendConnection().catch((err: unknown) => {
          logger.warn("Failed to close backend session", { sessionId, error: err });
        });
      }
      runtime.closeAllConsumers();
      runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "SESSION_CLOSED" } });
      store.remove(sessionId);
      runtimeManager.delete(sessionId);
      leaseCoordinator.releaseLease(sessionId, leaseOwnerId);
      metrics?.recordEvent({ timestamp: Date.now(), type: "session:closed", sessionId });
      emitEvent("session:closed", { sessionId });
    },
    closeAllSessions: async () => {
      for (const sessionId of runtimeManager.keys()) {
        await lifecycleService.closeSession(sessionId);
      }
      runtimeManager.clear();
    },
  };
  slashService = createSlashService({
    broadcaster,
    emitEvent: emitEvent as SlashEmitEvent,
    tracer,
    now: () => Date.now(),
    generateTraceId: () => generateTraceId(),
    generateSlashRequestId: () => generateSlashRequestId(),
    registerPendingPassthrough: (session: Session, entry: Session["pendingPassthroughs"][number]) =>
      runtimeManager.getOrCreate(session).enqueuePendingPassthrough(entry),
    sendUserMessage: (
      sessionId: string,
      content: string,
      trace?: { traceId?: string; requestId?: string; command?: string },
    ) =>
      runtimeApi.sendUserMessage(sessionId, content, {
        traceId: trace?.traceId,
        slashRequestId: trace?.requestId,
        slashCommand: trace?.command,
      }),
  });

  // ── Backend plane ─────────────────────────────────────────────────────────
  backendConnector = new BackendConnector(
    createBackendConnectorDeps({
      adapter: options?.adapter ?? null,
      adapterResolver: options?.adapterResolver ?? null,
      logger,
      metrics,
      broadcaster,
      routeUnifiedMessage: (session: Session, msg: UnifiedMessage) =>
        runtimeApi.handleBackendMessage(session.id, msg),
      emitEvent: emitEvent as EmitBridgeEvent,
      runtime: (session: Session) => runtimeManager.getOrCreate(session),
      tracer,
    }),
  );

  const consumerGateway = new ConsumerGateway(
    createConsumerGatewayDeps({
      store,
      gatekeeper,
      broadcaster,
      gitTracker,
      logger,
      metrics,
      emit: ((type: string, payload: unknown) =>
        emitEvent(type, payload)) as ConsumerGatewayDeps["emit"],
      routeConsumerMessage: (session: Session, msg: InboundCommand, ws: WebSocketLike) =>
        runtimeApi.handleInboundCommand(session.id, msg, ws),
      maxConsumerMessageSize: MAX_CONSUMER_MESSAGE_SIZE,
      tracer,
      runtimeAccessors,
    }),
  );

  return {
    core: { logger, config, tracer, gitResolver, metrics },
    store,
    runtimeManager,
    runtimeApi,
    backendConnector,
    capabilitiesPolicy,
    lifecycleService,
    consumerGateway,
    broadcaster,
  };
}
