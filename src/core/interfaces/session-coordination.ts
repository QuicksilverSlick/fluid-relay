import type { AuthContext, ConsumerIdentity } from "../../interfaces/auth.js";
import type { Logger } from "../../interfaces/logger.js";
import type { MetricsCollector } from "../../interfaces/metrics.js";
import type { RateLimiter } from "../../interfaces/rate-limiter.js";
import type { WebSocketLike } from "../../interfaces/transport.js";
import type { BridgeEventMap } from "../../types/events.js";
import type { GitInfoTracker } from "../session/git-info-tracker.js";
import type { Session } from "../session/session-repository.js";
import type { SessionRuntime } from "../session/session-runtime.js";
import type { InboundCommand } from "./runtime-commands.js";

export type EmitBridgeEvent = <K extends keyof BridgeEventMap>(
  event: K,
  payload: BridgeEventMap[K],
) => void;

export interface SessionStorePort {
  get(sessionId: string): Session | undefined;
}

export interface ConsumerGatekeeperPort {
  hasAuthenticator(): boolean;
  authenticateAsync(ws: WebSocketLike, context: AuthContext): Promise<ConsumerIdentity | null>;
  createAnonymousIdentity(index: number): ConsumerIdentity;
  cancelPendingAuth(ws: WebSocketLike): void;
  authorize(identity: ConsumerIdentity, messageType: InboundCommand["type"]): boolean;
  createRateLimiter(): RateLimiter | undefined;
}

export interface ConsumerBroadcasterPort {
  sendTo(ws: WebSocketLike, msg: Record<string, unknown>): void;
  broadcastPresence(session: Session): void;
}

export interface ConsumerTransportCoordinatorDeps {
  sessions: SessionStorePort;
  gatekeeper: ConsumerGatekeeperPort;
  broadcaster: ConsumerBroadcasterPort;
  gitTracker: GitInfoTracker;
  logger: Logger;
  metrics: MetricsCollector | null;
  emit: EmitBridgeEvent;
  getRuntime: (session: Session) => SessionRuntime;
  routeConsumerMessage: (session: Session, msg: InboundCommand, ws: WebSocketLike) => void;
  maxConsumerMessageSize: number;
}
