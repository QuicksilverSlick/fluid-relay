/**
 * buildSessionServices — flat factory that assembles all session services.
 *
 * Replaces the four separate compose-*-plane.ts files with a single flat
 * function. Circular dependencies between planes are resolved via lazy closure
 * variables (the same pattern as the old compose planes), because each lazy
 * getter is only called after all services have been assembled.
 *
 * @module SessionControl
 */

import { randomUUID } from "node:crypto";
import type { Authenticator } from "../../interfaces/auth.js";
import type { GitInfoResolver } from "../../interfaces/git-resolver.js";
import type { Logger } from "../../interfaces/logger.js";
import type { MetricsCollector } from "../../interfaces/metrics.js";
import type { SessionStorage } from "../../interfaces/storage.js";
import type { ProviderConfig } from "../../types/config.js";
import { resolveConfig } from "../../types/config.js";
import { noopLogger } from "../../utils/noop-logger.js";
import { BackendConnector } from "../backend/backend-connector.js";
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
import type { MessageTracer } from "../messaging/message-tracer.js";
import { noopTracer } from "../messaging/message-tracer.js";
import { GitInfoTracker } from "../session/git-info-tracker.js";
import { MessageQueueHandler } from "../session/message-queue-handler.js";
import {
  InMemorySessionLeaseCoordinator,
  type SessionLeaseCoordinator,
} from "../session/session-lease-coordinator.js";
import { SessionRepository } from "../session/session-repository.js";
import type { SessionServices } from "../session-services.js";
import { SlashCommandRegistry } from "../slash/slash-command-registry.js";
import { TeamToolCorrelationBuffer } from "../team/team-tool-correlation.js";
import { BackendApi } from "./backend-api.js";
import { forwardBridgeEventWithLifecycle } from "./bridge-event-forwarder.js";
import {
  generateSlashRequestId,
  generateTraceId,
  tracedNormalizeInbound,
} from "./message-tracing-utils.js";
import { RuntimeApi } from "./runtime-api.js";
import { createRuntimeManager } from "./runtime-manager-factory.js";
import { SessionBroadcastApi } from "./session-broadcast-api.js";
import {
  createBackendConnectorDeps,
  createCapabilitiesPolicyStateAccessors,
  createConsumerGatewayDeps,
  createConsumerPlaneRuntimeAccessors,
  createQueueStateAccessors,
} from "./session-deps-factory.js";
import { SessionInfoApi } from "./session-info-api.js";
import { SessionLifecycleService } from "./session-lifecycle-service.js";
import { SessionPersistenceService } from "./session-persistence-service.js";
import { createSlashService } from "./slash-service-factory.js";

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

  // ── Persistence ───────────────────────────────────────────────────────────
  const persistenceService = new SessionPersistenceService({ store, logger });

  // ── Lazy refs for circular dependency resolution ───────────────────────────
  // Each lazy getter is only called AFTER all services are constructed.
  let runtimeManager!: ReturnType<typeof createRuntimeManager>;
  let broadcaster!: ConsumerBroadcaster;
  let queueHandler!: MessageQueueHandler;
  let slashService!: ReturnType<typeof createSlashService>;
  let backendConnector!: BackendConnector;
  let gitTracker!: GitInfoTracker;
  let capabilitiesPolicy!: CapabilitiesPolicy;

  // ── emitEvent ─────────────────────────────────────────────────────────────
  // Wraps the raw emitter with lifecycle signal mirroring into RuntimeManager.
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
    persistSession: (runtimeSession) => persistenceService.persist(runtimeSession),
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
  const infoApi = new SessionInfoApi({
    store,
    runtimeManager,
    getOrCreateSession: (sessionId) => lifecycleService.getOrCreateSession(sessionId),
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
  const broadcastApi = new SessionBroadcastApi({ store, broadcaster });
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
      (session) => persistenceService.persistSync(session),
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
  const backendApi = new BackendApi({
    store,
    backendConnector,
    capabilitiesPolicy,
    getOrCreateSession: (sessionId) => lifecycleService.getOrCreateSession(sessionId),
  });

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
    runtimeApi,
    backendApi,
    infoApi,
    broadcastApi,
    lifecycleService,
    persistenceService,
    consumerGateway,
    broadcaster,
  };
}
