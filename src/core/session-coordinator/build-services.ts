/**
 * buildSessionServices — flat factory that assembles the four compose planes
 * into a single SessionServices object.
 *
 * Extracts the wiring logic that previously lived in the SessionBridge
 * constructor, making it available to SessionCoordinator without the facade.
 *
 * Circular dependencies between planes are resolved via lazy closure variables
 * (the same pattern as the old SessionBridge constructor), because each lazy
 * getter is only called after all four planes have been assembled.
 *
 * @module SessionControl
 */

import { forwardBridgeEventWithLifecycle } from "../bridge/bridge-event-forwarder.js";
import { composeBackendPlane } from "../session-bridge/compose-backend-plane.js";
import type { ConsumerPlane } from "../session-bridge/compose-consumer-plane.js";
import { composeConsumerPlane } from "../session-bridge/compose-consumer-plane.js";
import type { MessagePlane } from "../session-bridge/compose-message-plane.js";
import { composeMessagePlane } from "../session-bridge/compose-message-plane.js";
import type { RuntimePlane } from "../session-bridge/compose-runtime-plane.js";
import { composeRuntimePlane } from "../session-bridge/compose-runtime-plane.js";
import type { SessionBridgeInitOptions } from "../session-bridge/types.js";
import type { SessionServices } from "../session-services.js";

/**
 * Assemble all four planes into a flat SessionServices object.
 *
 * @param options - Init options forwarded from SessionCoordinator
 * @param emit - Raw bridge-event emitter (typically a TypedEventEmitter.emit)
 */
export function buildSessionServices(
  options: SessionBridgeInitOptions | undefined,
  emit: (type: string, payload: unknown) => void,
): SessionServices {
  // Lazy-resolution refs — filled in as each plane is assembled.
  // TypeScript `!` signals definite assignment; the lazy getters below
  // are only called after all four assignments complete.
  let runtimePlane!: RuntimePlane;
  let consumerPlane!: ConsumerPlane;
  let messagePlane!: MessagePlane;

  // emitEvent wraps the raw emitter with lifecycle signal mirroring into
  // RuntimeManager. Uses runtimePlane lazily (called only after init).
  const emitEvent = (type: string, payload: unknown) =>
    forwardBridgeEventWithLifecycle(runtimePlane.runtimeManager, emit, type, payload);

  runtimePlane = composeRuntimePlane({
    options,
    emitPermissionResolved: (sessionId, requestId, behavior) =>
      emit("permission:resolved", { sessionId, requestId, behavior }),
    getOrCreateSession: (sessionId) => messagePlane.lifecycleService.getOrCreateSession(sessionId),
    getBroadcaster: () => consumerPlane.broadcaster,
    getQueueHandler: () => messagePlane.queueHandler,
    getSlashService: () => messagePlane.slashService,
    getBackendConnector: () => backendServices.backendConnector,
    getPersistenceService: () => runtimePlane.persistenceService,
    getGitTracker: () => consumerPlane.gitTracker,
    getCapabilitiesPolicy: () => messagePlane.capabilitiesPolicy,
    emitEvent,
  });

  consumerPlane = composeConsumerPlane({
    store: runtimePlane.store,
    logger: runtimePlane.core.logger,
    tracer: runtimePlane.core.tracer,
    config: runtimePlane.core.config,
    metrics: runtimePlane.core.metrics,
    gitResolver: runtimePlane.core.gitResolver,
    authenticator: options?.authenticator,
    rateLimiterFactory: options?.rateLimiterFactory,
    runtime: (session) => runtimePlane.runtimeManager.getOrCreate(session),
    routeConsumerMessage: (session, msg, ws) =>
      runtimePlane.runtimeApi.handleInboundCommand(session.id, msg, ws),
    emit: (type, payload) => emitEvent(type, payload as unknown),
  });

  messagePlane = composeMessagePlane({
    config: runtimePlane.core.config,
    logger: runtimePlane.core.logger,
    metrics: runtimePlane.core.metrics,
    store: runtimePlane.store,
    runtimeManager: runtimePlane.runtimeManager,
    tracer: runtimePlane.core.tracer,
    gitResolver: runtimePlane.core.gitResolver,
    broadcaster: consumerPlane.broadcaster,
    gitTracker: consumerPlane.gitTracker,
    persistenceService: runtimePlane.persistenceService,
    runtime: (session) => runtimePlane.runtimeManager.getOrCreate(session),
    emitEvent,
    emitSessionClosed: (sessionId) => emitEvent("session:closed", { sessionId }),
    leaseCoordinator: runtimePlane.leaseCoordinator,
    leaseOwnerId: runtimePlane.leaseOwnerId,
    sendUserMessage: (sessionId, content, opts) =>
      runtimePlane.runtimeApi.sendUserMessage(sessionId, content, opts),
  });

  const backendServices = composeBackendPlane({
    options,
    store: runtimePlane.store,
    logger: runtimePlane.core.logger,
    metrics: runtimePlane.core.metrics,
    tracer: runtimePlane.core.tracer,
    broadcaster: consumerPlane.broadcaster,
    capabilitiesPolicy: messagePlane.capabilitiesPolicy,
    runtime: (session) => runtimePlane.runtimeManager.getOrCreate(session),
    routeBackendMessage: (sessionId, message) =>
      runtimePlane.runtimeApi.handleBackendMessage(sessionId, message),
    emitEvent,
    getOrCreateSession: (sessionId) => messagePlane.lifecycleService.getOrCreateSession(sessionId),
  });

  return {
    core: runtimePlane.core,
    store: runtimePlane.store,
    runtimeApi: runtimePlane.runtimeApi,
    backendApi: backendServices.backendApi,
    infoApi: runtimePlane.infoApi,
    broadcastApi: consumerPlane.broadcastApi,
    lifecycleService: messagePlane.lifecycleService,
    persistenceService: runtimePlane.persistenceService,
    consumerGateway: consumerPlane.consumerGateway,
    broadcaster: consumerPlane.broadcaster,
  };
}
