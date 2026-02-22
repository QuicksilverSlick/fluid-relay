import { resolveConfig } from "../../types/config.js";
import { noopLogger } from "../../utils/noop-logger.js";
import type { BackendConnector } from "../backend/backend-connector.js";
import { tracedNormalizeInbound } from "../bridge/message-tracing-utils.js";
import { RuntimeApi } from "../bridge/runtime-api.js";
import type { RuntimeManager } from "../bridge/runtime-manager.js";
import { createRuntimeManager } from "../bridge/runtime-manager-factory.js";
import { SessionInfoApi } from "../bridge/session-info-api.js";
import { SessionPersistenceService } from "../bridge/session-persistence-service.js";
import type { ConsumerBroadcaster } from "../consumer/consumer-broadcaster.js";
import type { MessageTracer } from "../messaging/message-tracer.js";
import { noopTracer } from "../messaging/message-tracer.js";
import type { UnifiedMessageRouter } from "../messaging/unified-message-router.js";
import type { GitInfoTracker } from "../session/git-info-tracker.js";
import type { MessageQueueHandler } from "../session/message-queue-handler.js";
import { type Session, SessionRepository } from "../session/session-repository.js";
import { SlashCommandRegistry } from "../slash/slash-command-registry.js";
import type { SlashCommandService } from "../slash/slash-command-service.js";
import { TeamToolCorrelationBuffer } from "../team/team-tool-correlation.js";
import type { BridgeCoreContext, SessionBridgeInitOptions } from "./types.js";

type ComposeRuntimePlaneOptions = {
  options?: SessionBridgeInitOptions;
  emitPermissionResolved: (
    sessionId: string,
    requestId: string,
    behavior: "allow" | "deny",
  ) => void;
  getOrCreateSession: (sessionId: string) => Session;
  getBroadcaster: () => ConsumerBroadcaster;
  getQueueHandler: () => MessageQueueHandler;
  getSlashService: () => SlashCommandService;
  getBackendConnector: () => BackendConnector;
  getPersistenceService: () => SessionPersistenceService;
  getGitTracker: () => GitInfoTracker;
  getMessageRouter: () => UnifiedMessageRouter;
};

export type RuntimePlane = {
  core: BridgeCoreContext;
  store: SessionRepository;
  runtimeManager: RuntimeManager;
  runtimeApi: RuntimeApi;
  persistenceService: SessionPersistenceService;
  infoApi: SessionInfoApi;
};

export function composeRuntimePlane({
  options,
  emitPermissionResolved,
  getOrCreateSession,
  getBroadcaster,
  getQueueHandler,
  getSlashService,
  getBackendConnector,
  getPersistenceService,
  getGitTracker,
  getMessageRouter,
}: ComposeRuntimePlaneOptions): RuntimePlane {
  const store = new SessionRepository(options?.storage ?? null, {
    createCorrelationBuffer: () => new TeamToolCorrelationBuffer(),
    createRegistry: () => new SlashCommandRegistry(),
  });
  const logger = options?.logger ?? noopLogger;
  const config = resolveConfig(options?.config ?? { port: 9414 });
  const tracer = options?.tracer ?? noopTracer;
  const gitResolver = options?.gitResolver ?? null;
  const metrics = options?.metrics ?? null;

  const runtimeManager = createRuntimeManager({
    now: () => Date.now(),
    maxMessageHistoryLength: config.maxMessageHistoryLength,
    getBroadcaster,
    getQueueHandler,
    getSlashService,
    sendToBackend: (runtimeSession, message) =>
      getBackendConnector().sendToBackend(runtimeSession, message),
    tracedNormalizeInbound: (runtimeSession, inbound, trace) =>
      tracedNormalizeInbound(tracer, inbound, runtimeSession.id, trace),
    persistSession: (runtimeSession) => getPersistenceService().persist(runtimeSession),
    warnUnknownPermission: (sessionId, requestId) =>
      logger.warn(
        `Permission response for unknown request_id ${requestId} in session ${sessionId}`,
      ),
    emitPermissionResolved,
    onSessionSeeded: (runtimeSession) => getGitTracker().resolveGitInfo(runtimeSession),
    onInvalidLifecycleTransition: ({ sessionId, from, to, reason }) =>
      logger.warn("Session lifecycle invalid transition", {
        sessionId,
        current: from,
        next: to,
        reason,
      }),
    routeBackendMessage: (runtimeSession, unified) =>
      getMessageRouter().route(runtimeSession, unified),
  });

  const runtimeApi = new RuntimeApi({
    store,
    runtimeManager,
    logger,
  });
  const persistenceService = new SessionPersistenceService({
    store,
    logger,
  });
  const infoApi = new SessionInfoApi({
    store,
    runtimeManager,
    getOrCreateSession,
  });

  return {
    core: {
      logger,
      config,
      tracer: tracer as MessageTracer,
      gitResolver,
      metrics,
    },
    store,
    runtimeManager,
    runtimeApi,
    persistenceService,
    infoApi,
  };
}
