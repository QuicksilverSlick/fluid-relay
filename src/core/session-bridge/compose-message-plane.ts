import type { Logger } from "../../interfaces/logger.js";
import type { MetricsCollector } from "../../interfaces/metrics.js";
import type { ResolvedConfig } from "../../types/config.js";
import { generateSlashRequestId, generateTraceId } from "../bridge/message-tracing-utils.js";
import type { RuntimeManager } from "../bridge/runtime-manager.js";
import {
  createCapabilitiesPolicyStateAccessors,
  createQueueStateAccessors,
  createUnifiedMessageRouterDeps,
} from "../bridge/session-bridge-deps-factory.js";
import { SessionLifecycleService } from "../bridge/session-lifecycle-service.js";
import type { SessionPersistenceService } from "../bridge/session-persistence-service.js";
import { createSlashService } from "../bridge/slash-service-factory.js";
import { CapabilitiesPolicy } from "../capabilities/capabilities-policy.js";
import type { ConsumerBroadcaster } from "../consumer/consumer-broadcaster.js";
import type { MessageTracer } from "../messaging/message-tracer.js";
import { UnifiedMessageRouter } from "../messaging/unified-message-router.js";
import { MessageQueueHandler } from "../session/message-queue-handler.js";
import type { SessionLeaseCoordinator } from "../session/session-lease-coordinator.js";
import type { SessionRepository } from "../session/session-repository.js";
import type { RuntimeAccessor } from "./types.js";

type ComposeMessagePlaneOptions = {
  config: ResolvedConfig;
  logger: Logger;
  metrics: MetricsCollector | null;
  store: SessionRepository;
  runtimeManager: RuntimeManager;
  tracer: MessageTracer;
  gitResolver: import("../../interfaces/git-resolver.js").GitInfoResolver | null;
  broadcaster: ConsumerBroadcaster;
  gitTracker: import("../session/git-info-tracker.js").GitInfoTracker;
  persistenceService: SessionPersistenceService;
  runtime: RuntimeAccessor;
  emitEvent: (type: string, payload: unknown) => void;
  emitSessionClosed: (sessionId: string) => void;
  leaseCoordinator?: SessionLeaseCoordinator;
  leaseOwnerId?: string;
  sendUserMessage: (
    sessionId: string,
    content: string,
    options?: {
      sessionIdOverride?: string;
      images?: { media_type: string; data: string }[];
      traceId?: string;
      slashRequestId?: string;
      slashCommand?: string;
    },
  ) => void;
};

export type MessagePlane = {
  capabilitiesPolicy: CapabilitiesPolicy;
  queueHandler: MessageQueueHandler;
  slashService: import("../slash/slash-command-service.js").SlashCommandService;
  messageRouter: UnifiedMessageRouter;
  lifecycleService: SessionLifecycleService;
};

export function composeMessagePlane({
  config,
  logger,
  metrics,
  store,
  runtimeManager,
  tracer,
  gitResolver,
  broadcaster,
  gitTracker,
  persistenceService,
  runtime,
  emitEvent,
  emitSessionClosed,
  leaseCoordinator,
  leaseOwnerId,
  sendUserMessage,
}: ComposeMessagePlaneOptions): MessagePlane {
  const capabilitiesPolicy = new CapabilitiesPolicy(
    config,
    logger,
    broadcaster,
    emitEvent,
    (session) => persistenceService.persist(session),
    createCapabilitiesPolicyStateAccessors((session) => runtime(session)),
  );
  const queueHandler = new MessageQueueHandler(
    broadcaster,
    (sessionId, content, opts) => sendUserMessage(sessionId, content, opts),
    createQueueStateAccessors(
      (session) => runtime(session),
      (session) => persistenceService.persistSync(session),
    ),
  );
  const lifecycleService = new SessionLifecycleService({
    store,
    runtimeManager,
    capabilitiesPolicy,
    metrics,
    logger,
    emitSessionClosed,
    leaseCoordinator,
    leaseOwnerId,
  });
  const slashService = createSlashService({
    broadcaster,
    emitEvent,
    tracer,
    now: () => Date.now(),
    generateTraceId: () => generateTraceId(),
    generateSlashRequestId: () => generateSlashRequestId(),
    registerPendingPassthrough: (session, entry) =>
      runtime(session).enqueuePendingPassthrough(entry),
    sendUserMessage: (sessionId, content, trace) =>
      sendUserMessage(sessionId, content, {
        traceId: trace?.traceId,
        slashRequestId: trace?.requestId,
        slashCommand: trace?.command,
      }),
  });
  const messageRouter = new UnifiedMessageRouter(
    createUnifiedMessageRouterDeps({
      broadcaster,
      capabilitiesPolicy,
      queueHandler,
      gitTracker,
      gitResolver,
      emitEvent,
      persistSession: (session) => persistenceService.persist(session),
      maxMessageHistoryLength: config.maxMessageHistoryLength,
      tracer,
      runtime: (session) => runtime(session),
    }),
  );

  return {
    capabilitiesPolicy,
    queueHandler,
    slashService,
    messageRouter,
    lifecycleService,
  };
}
