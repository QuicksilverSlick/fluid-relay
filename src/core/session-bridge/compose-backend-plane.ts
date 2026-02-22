import type { Logger } from "../../interfaces/logger.js";
import type { MetricsCollector } from "../../interfaces/metrics.js";
import { BackendConnector } from "../backend/backend-connector.js";
import { BackendApi } from "../bridge/backend-api.js";
import { createBackendConnectorDeps } from "../bridge/session-bridge-deps-factory.js";
import type { CapabilitiesPolicy } from "../capabilities/capabilities-policy.js";
import type { ConsumerBroadcaster } from "../consumer/consumer-broadcaster.js";
import type { MessageTracer } from "../messaging/message-tracer.js";
import type { Session, SessionRepository } from "../session/session-repository.js";
import type { UnifiedMessage } from "../types/unified-message.js";
import type { RuntimeAccessor, SessionBridgeInitOptions } from "./types.js";

type ComposeBackendPlaneOptions = {
  options?: SessionBridgeInitOptions;
  store: SessionRepository;
  logger: Logger;
  metrics: MetricsCollector | null;
  tracer: MessageTracer;
  broadcaster: ConsumerBroadcaster;
  capabilitiesPolicy: CapabilitiesPolicy;
  runtime: RuntimeAccessor;
  routeBackendMessage: (sessionId: string, msg: UnifiedMessage) => void;
  emitEvent: (type: string, payload: unknown) => void;
  getOrCreateSession: (sessionId: string) => Session;
};

export type BackendPlane = {
  backendConnector: BackendConnector;
  backendApi: BackendApi;
};

export function composeBackendPlane({
  options,
  store,
  logger,
  metrics,
  tracer,
  broadcaster,
  capabilitiesPolicy,
  runtime,
  routeBackendMessage,
  emitEvent,
  getOrCreateSession,
}: ComposeBackendPlaneOptions): BackendPlane {
  const backendConnector = new BackendConnector(
    createBackendConnectorDeps({
      adapter: options?.adapter ?? null,
      adapterResolver: options?.adapterResolver ?? null,
      logger,
      metrics,
      broadcaster,
      routeUnifiedMessage: (session, msg) => routeBackendMessage(session.id, msg),
      emitEvent,
      runtime: (session) => runtime(session),
      tracer,
    }),
  );
  const backendApi = new BackendApi({
    store,
    backendConnector,
    capabilitiesPolicy,
    getOrCreateSession,
  });

  return {
    backendConnector,
    backendApi,
  };
}
