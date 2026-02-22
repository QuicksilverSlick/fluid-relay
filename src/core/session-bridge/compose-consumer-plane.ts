import type { GitInfoResolver } from "../../interfaces/git-resolver.js";
import type { Logger } from "../../interfaces/logger.js";
import type { MetricsCollector } from "../../interfaces/metrics.js";
import type { WebSocketLike } from "../../interfaces/transport.js";
import type { ResolvedConfig } from "../../types/config.js";
import type { BridgeEventMap } from "../../types/events.js";
import { createConsumerGatewayDeps } from "../bridge/session-bridge-deps-factory.js";
import { SessionBroadcastApi } from "../bridge/session-broadcast-api.js";
import {
  ConsumerBroadcaster,
  MAX_CONSUMER_MESSAGE_SIZE,
} from "../consumer/consumer-broadcaster.js";
import { ConsumerGatekeeper } from "../consumer/consumer-gatekeeper.js";
import { ConsumerGateway } from "../consumer/consumer-gateway.js";
import type { InboundCommand } from "../interfaces/runtime-commands.js";
import type { MessageTracer } from "../messaging/message-tracer.js";
import { GitInfoTracker } from "../session/git-info-tracker.js";
import type { Session, SessionRepository } from "../session/session-repository.js";
import type { RuntimeAccessor, SessionBridgeInitOptions } from "./types.js";

type ComposeConsumerPlaneOptions = {
  store: SessionRepository;
  logger: Logger;
  tracer: MessageTracer;
  config: ResolvedConfig;
  metrics: MetricsCollector | null;
  gitResolver: GitInfoResolver | null;
  authenticator: SessionBridgeInitOptions["authenticator"];
  rateLimiterFactory: SessionBridgeInitOptions["rateLimiterFactory"];
  runtime: RuntimeAccessor;
  routeConsumerMessage: (session: Session, msg: InboundCommand, ws: WebSocketLike) => void;
  emit: <K extends keyof BridgeEventMap>(type: K, payload: BridgeEventMap[K]) => void;
};

export type ConsumerPlane = {
  broadcaster: ConsumerBroadcaster;
  broadcastApi: SessionBroadcastApi;
  gatekeeper: ConsumerGatekeeper;
  gitTracker: GitInfoTracker;
  consumerGateway: ConsumerGateway;
};

export function composeConsumerPlane({
  store,
  logger,
  tracer,
  config,
  metrics,
  gitResolver,
  authenticator,
  rateLimiterFactory,
  runtime,
  routeConsumerMessage,
  emit,
}: ComposeConsumerPlaneOptions): ConsumerPlane {
  const broadcaster = new ConsumerBroadcaster(
    logger,
    (sessionId, msg) => emit("message:outbound", { sessionId, message: msg }),
    tracer,
    (session, ws) => runtime(session).removeConsumer(ws),
    {
      getConsumerSockets: (session) => runtime(session).getConsumerSockets(),
    },
  );
  const broadcastApi = new SessionBroadcastApi({
    store,
    broadcaster,
  });
  const gatekeeper = new ConsumerGatekeeper(authenticator ?? null, config, rateLimiterFactory);
  const gitTracker = new GitInfoTracker(gitResolver ?? null, {
    getState: (session) => runtime(session).getState(),
    setState: (session, state) => runtime(session).setState(state),
  });
  const consumerGateway = new ConsumerGateway(
    createConsumerGatewayDeps({
      store,
      gatekeeper,
      broadcaster,
      gitTracker,
      logger,
      metrics,
      emit,
      routeConsumerMessage,
      maxConsumerMessageSize: MAX_CONSUMER_MESSAGE_SIZE,
      tracer,
      runtime,
    }),
  );

  return {
    broadcaster,
    broadcastApi,
    gatekeeper,
    gitTracker,
    consumerGateway,
  };
}
