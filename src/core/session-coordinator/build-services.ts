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
import type { Authenticator, ConsumerIdentity } from "../../interfaces/auth.js";
import type { GitInfoResolver } from "../../interfaces/git-resolver.js";
import type { Logger } from "../../interfaces/logger.js";
import type { MetricsCollector } from "../../interfaces/metrics.js";
import type { SessionStorage } from "../../interfaces/storage.js";
import type { WebSocketLike } from "../../interfaces/transport.js";
import type { InitializeCommand } from "../../types/cli-messages.js";
import type { ProviderConfig } from "../../types/config.js";
import { resolveConfig } from "../../types/config.js";
import type { BridgeEventMap } from "../../types/events.js";
import { noopLogger } from "../../utils/noop-logger.js";
import { BackendConnector, type BackendConnectorDeps } from "../backend/backend-connector.js";
import { CapabilitiesPolicy } from "../capabilities/capabilities-policy.js";
import {
  ConsumerBroadcaster,
  MAX_CONSUMER_MESSAGE_SIZE,
} from "../consumer/consumer-broadcaster.js";
import type { RateLimiterFactory } from "../consumer/consumer-gatekeeper.js";
import { ConsumerGatekeeper } from "../consumer/consumer-gatekeeper.js";
import { ConsumerGateway, type ConsumerGatewayDeps } from "../consumer/consumer-gateway.js";
import type { AdapterResolver } from "../interfaces/adapter-resolver.js";
import type { BackendAdapter } from "../interfaces/backend-adapter.js";
import type { InboundCommand } from "../interfaces/runtime-commands.js";
import type { MessageTracer } from "../messaging/message-tracer.js";
import { noopTracer } from "../messaging/message-tracer.js";
import {
  generateSlashRequestId,
  generateTraceId,
  tracedNormalizeInbound,
} from "../messaging/message-tracing-utils.js";
import { GitInfoTracker } from "../session/git-info-tracker.js";
import { MessageQueueHandler } from "../session/message-queue-handler.js";
import type { SessionData } from "../session/session-data.js";
import {
  InMemorySessionLeaseCoordinator,
  type SessionLeaseCoordinator,
} from "../session/session-lease-coordinator.js";
import type {
  Session,
  SessionRepository as SessionRepositoryType,
} from "../session/session-repository.js";
import { SessionRepository } from "../session/session-repository.js";
import type { SessionRuntime } from "../session/session-runtime.js";
import {
  type SessionRuntimeDeps,
  SessionRuntime as SessionRuntimeImpl,
} from "../session/session-runtime.js";
import type { SessionServices } from "../session-services.js";
import {
  AdapterNativeHandler,
  LocalHandler,
  PassthroughHandler,
  SlashCommandChain,
  UnsupportedHandler,
} from "../slash/slash-command-chain.js";
import { SlashCommandExecutor } from "../slash/slash-command-executor.js";
import { SlashCommandRegistry } from "../slash/slash-command-registry.js";
import { SlashCommandService } from "../slash/slash-command-service.js";
import { TeamToolCorrelationBuffer } from "../team/team-tool-correlation.js";
import type { UnifiedMessage } from "../types/unified-message.js";
import { RuntimeApi } from "./runtime-api.js";
import { RuntimeManager } from "./runtime-manager.js";
import { SessionLifecycleService } from "./session-lifecycle-service.js";

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
  runtimeManager: Pick<RuntimeManager, "handleLifecycleSignal">,
  emit: (type: string, payload: unknown) => void,
  type: string,
  payload: unknown,
): void {
  if (payload && typeof payload === "object" && "sessionId" in payload && isLifecycleSignal(type)) {
    const sessionId = (payload as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === "string") {
      runtimeManager.handleLifecycleSignal(sessionId, type);
    }
  }
  emit(type, payload);
}

// ---------------------------------------------------------------------------
// Inlined: runtime-manager-factory (createRuntimeManager)
// ---------------------------------------------------------------------------
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

function createRuntimeManager(deps: RuntimeManagerFactoryDeps): RuntimeManager {
  return new RuntimeManager(
    (session: Session) =>
      new SessionRuntimeImpl(session, {
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
      }),
  );
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
    onBackendConnectedState: (session: Session, connectedParams) =>
      params.runtime(session).attachBackendConnection(connectedParams),
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
  let runtimeManager!: RuntimeManager;
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
    sendToBackend: (runtimeSession, message) =>
      backendConnector.sendToBackend(runtimeSession, message),
    tracedNormalizeInbound: (runtimeSession, inbound, trace) =>
      tracedNormalizeInbound(tracer, inbound, runtimeSession.id, trace),
    persistSession: (runtimeSession) => store.persist(runtimeSession),
    warnUnknownPermission: (sessionId, requestId) =>
      logger.warn(
        `Permission response for unknown request_id ${requestId} in session ${sessionId}`,
      ),
    emitPermissionResolved: (sessionId, requestId, behavior) =>
      emit("permission:resolved", { sessionId, requestId, behavior }),
    onSessionSeeded: (runtimeSession) => gitTracker.resolveGitInfo(runtimeSession),
    onInvalidLifecycleTransition: ({ sessionId, from, to, reason }) =>
      logger.warn("Session lifecycle invalid transition", {
        sessionId,
        current: from,
        next: to,
        reason,
      }),
    canMutateSession: (sessionId) => leaseCoordinator.ensureLease(sessionId, leaseOwnerId),
    onMutationRejected: (sessionId, operation) =>
      logger.warn(`Mutation rejected for session ${sessionId}: ${operation}`),
    emitEvent,
    getGitTracker: () => gitTracker,
    gitResolver,
    getCapabilitiesPolicy: () => capabilitiesPolicy,
  });

  const runtimeApi = new RuntimeApi({
    store,
    runtimeManager,
    logger,
    leaseCoordinator,
    leaseOwnerId,
  });

  // ── Consumer plane ────────────────────────────────────────────────────────
  const runtimeAccessors = createConsumerPlaneRuntimeAccessors((session) =>
    runtimeManager.getOrCreate(session),
  );
  broadcaster = new ConsumerBroadcaster(
    logger,
    (sessionId, msg) => emitEvent("message:outbound", { sessionId, message: msg }),
    tracer,
    (session, ws) => runtimeAccessors.removeConsumer(session, ws),
    {
      getConsumerSockets: (session) => runtimeAccessors.getConsumerSockets(session),
    },
  );
  const gatekeeper = new ConsumerGatekeeper(
    options?.authenticator ?? null,
    config,
    options?.rateLimiterFactory,
  );
  gitTracker = new GitInfoTracker(gitResolver, {
    getState: (session) => runtimeAccessors.getState(session),
    setState: (session, state) => runtimeAccessors.setState(session, state),
  });

  // ── Message plane ─────────────────────────────────────────────────────────
  capabilitiesPolicy = new CapabilitiesPolicy(
    config,
    logger,
    broadcaster,
    emitEvent,
    createCapabilitiesPolicyStateAccessors((session) => runtimeManager.getOrCreate(session)),
  );
  queueHandler = new MessageQueueHandler(
    broadcaster,
    (sessionId, content, opts) => runtimeApi.sendUserMessage(sessionId, content, opts),
    createQueueStateAccessors(
      (session) => runtimeManager.getOrCreate(session),
      (session) => store.persistSync(session),
    ),
  );
  const lifecycleService = new SessionLifecycleService({
    store,
    runtimeManager,
    capabilitiesPolicy,
    metrics,
    logger,
    emitSessionClosed: (sessionId) => emitEvent("session:closed", { sessionId }),
    leaseCoordinator,
    leaseOwnerId,
  });
  slashService = createSlashService({
    broadcaster,
    emitEvent,
    tracer,
    now: () => Date.now(),
    generateTraceId: () => generateTraceId(),
    generateSlashRequestId: () => generateSlashRequestId(),
    registerPendingPassthrough: (session, entry) =>
      runtimeManager.getOrCreate(session).enqueuePendingPassthrough(entry),
    sendUserMessage: (sessionId, content, trace) =>
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
      routeUnifiedMessage: (session, msg) => runtimeApi.handleBackendMessage(session.id, msg),
      emitEvent,
      runtime: (session) => runtimeManager.getOrCreate(session),
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
      routeConsumerMessage: (session, msg, ws) =>
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
