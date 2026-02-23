import type { ConsumerIdentity } from "../../interfaces/auth.js";
import type { Logger } from "../../interfaces/logger.js";
import type { MetricsCollector } from "../../interfaces/metrics.js";
import type { WebSocketLike } from "../../interfaces/transport.js";
import type { InitializeCommand } from "../../types/cli-messages.js";
import type { BridgeEventMap } from "../../types/events.js";
import type { BackendConnectorDeps } from "../backend/backend-connector.js";
import type { CapabilitiesPolicy } from "../capabilities/capabilities-policy.js";
import type { ConsumerBroadcaster } from "../consumer/consumer-broadcaster.js";
import type { ConsumerGatekeeper } from "../consumer/consumer-gatekeeper.js";
import type { ConsumerGatewayDeps } from "../consumer/consumer-gateway.js";
import type { AdapterResolver } from "../interfaces/adapter-resolver.js";
import type { BackendAdapter } from "../interfaces/backend-adapter.js";
import type { InboundCommand } from "../interfaces/runtime-commands.js";
import type { MessageTracer } from "../messaging/message-tracer.js";
import type { UnifiedMessageRouterDeps } from "../messaging/unified-message-router.js";
import type { GitInfoTracker } from "../session/git-info-tracker.js";
import type { MessageQueueHandler } from "../session/message-queue-handler.js";
import type { SessionData } from "../session/session-data.js";
import type { Session, SessionRepository } from "../session/session-repository.js";
import type { SessionRuntime } from "../session/session-runtime.js";
import type { UnifiedMessage } from "../types/unified-message.js";

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

export type ConsumerPlaneRuntimeAccessors = {
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

export function createCapabilitiesPolicyStateAccessors(
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

export function createQueueStateAccessors(
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

export function createConsumerPlaneRuntimeAccessors(
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

export function createUnifiedMessageRouterDeps(params: {
  broadcaster: ConsumerBroadcaster;
  capabilitiesPolicy: CapabilitiesPolicy;
  queueHandler: MessageQueueHandler;
  gitTracker: GitInfoTracker;
  gitResolver: UnifiedMessageRouterDeps["gitResolver"];
  emitEvent: (type: string, payload: unknown) => void;
  persistSession: (session: Session) => void;
  maxMessageHistoryLength: number;
  tracer: MessageTracer;
  runtime: (session: Session) => SessionRuntime;
}): UnifiedMessageRouterDeps {
  return {
    broadcaster: params.broadcaster,
    capabilitiesPolicy: params.capabilitiesPolicy,
    queueHandler: params.queueHandler,
    gitTracker: params.gitTracker,
    gitResolver: params.gitResolver,
    emitEvent: params.emitEvent,
    persistSession: params.persistSession,
    maxMessageHistoryLength: params.maxMessageHistoryLength,
    tracer: params.tracer,
    getState: (session: Session) => params.runtime(session).getState(),
    setState: (session: Session, state: SessionData["state"]) =>
      params.runtime(session).setState(state),
    setBackendSessionId: (session: Session, backendSessionId: string | undefined) =>
      params.runtime(session).setBackendSessionId(backendSessionId),
    getMessageHistory: (session: Session) => params.runtime(session).getMessageHistory(),
    setMessageHistory: (session: Session, history: SessionData["messageHistory"]) =>
      params.runtime(session).setMessageHistory(history),
    getLastStatus: (session: Session) => params.runtime(session).getLastStatus(),
    storePendingPermission: (session: Session, requestId: string, request) =>
      params.runtime(session).storePendingPermission(requestId, request),
    clearDynamicSlashRegistry: (session: Session) =>
      params.runtime(session).clearDynamicSlashRegistry(),
    registerCLICommands: (session: Session, commands) =>
      params.runtime(session).registerCLICommands(commands),
    registerSkillCommands: (session: Session, skills: string[]) =>
      params.runtime(session).registerSkillCommands(skills),
  };
}

export function createBackendConnectorDeps(params: {
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

export function createConsumerGatewayDeps(params: {
  store: SessionRepository;
  gatekeeper: ConsumerGatekeeper;
  broadcaster: ConsumerBroadcaster;
  gitTracker: GitInfoTracker;
  logger: Logger;
  metrics: MetricsCollector | null;
  emit: ConsumerGatewayDeps["emit"];
  routeConsumerMessage: (session: Session, msg: InboundCommand, ws: WebSocketLike) => void;
  maxConsumerMessageSize: number;
  tracer: MessageTracer;
  runtimeAccessors: Pick<
    ConsumerPlaneRuntimeAccessors,
    | "allocateAnonymousIdentityIndex"
    | "checkRateLimit"
    | "getConsumerIdentity"
    | "getConsumerCount"
    | "getState"
    | "getMessageHistory"
    | "getPendingPermissions"
    | "getQueuedMessage"
    | "isBackendConnected"
    | "addConsumer"
    | "removeConsumer"
  >;
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
    registerConsumer: (session: Session, ws: WebSocketLike, identity) =>
      params.runtimeAccessors.addConsumer(session, ws, identity),
    unregisterConsumer: (session: Session, ws: WebSocketLike) =>
      params.runtimeAccessors.removeConsumer(session, ws),
    routeConsumerMessage: params.routeConsumerMessage,
    maxConsumerMessageSize: params.maxConsumerMessageSize,
    tracer: params.tracer,
  };
}
