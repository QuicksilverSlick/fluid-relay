import type { Authenticator } from "../../interfaces/auth.js";
import type { GitInfoResolver } from "../../interfaces/git-resolver.js";
import type { Logger } from "../../interfaces/logger.js";
import type { MetricsCollector } from "../../interfaces/metrics.js";
import type { SessionStorage } from "../../interfaces/storage.js";
import type { ProviderConfig, ResolvedConfig } from "../../types/config.js";
import type { BridgeEventMap } from "../../types/events.js";
import type { AdapterResolver } from "../interfaces/adapter-resolver.js";
import type { BackendAdapter } from "../interfaces/backend-adapter.js";
import type { MessageTracer } from "../messaging/message-tracer.js";
import type { SessionLeaseCoordinator } from "../session/session-lease-coordinator.js";
import type { Session } from "../session/session-repository.js";
import type { SessionRuntime } from "../session/session-runtime.js";

export type SessionBridgeInitOptions = {
  storage?: SessionStorage;
  gitResolver?: GitInfoResolver;
  authenticator?: Authenticator;
  logger?: Logger;
  config?: ProviderConfig;
  metrics?: MetricsCollector;
  adapter?: BackendAdapter;
  adapterResolver?: AdapterResolver;
  rateLimiterFactory?: import("../consumer/consumer-gatekeeper.js").RateLimiterFactory;
  tracer?: MessageTracer;
  leaseCoordinator?: SessionLeaseCoordinator;
  leaseOwnerId?: string;
};

export type EmitBridgeEvent = <K extends keyof BridgeEventMap>(
  type: K,
  payload: BridgeEventMap[K],
) => void;

export type RuntimeAccessor = (session: Session) => SessionRuntime;

export type BridgeCoreContext = {
  logger: Logger;
  config: ResolvedConfig;
  tracer: MessageTracer;
  gitResolver: GitInfoResolver | null;
  metrics: MetricsCollector | null;
};
