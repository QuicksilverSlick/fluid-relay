/**
 * SessionServices — flat registry of all services produced by buildSessionServices.
 *
 * Replaces `SessionBridge`'s 21 private fields with a single typed object.
 * Used by `SessionCoordinator` to wire together session control, backend,
 * consumer, and message services without going through the `SessionBridge` facade.
 *
 * @module SessionControl
 */

import type { GitInfoResolver } from "../interfaces/git-resolver.js";
import type { Logger } from "../interfaces/logger.js";
import type { MetricsCollector } from "../interfaces/metrics.js";
import type { ResolvedConfig } from "../types/config.js";
import type { BackendConnector } from "./backend/backend-connector.js";
import type { CapabilitiesPolicy } from "./capabilities/capabilities-policy.js";
import type { ConsumerBroadcaster } from "./consumer/consumer-broadcaster.js";
import type { ConsumerGateway } from "./consumer/consumer-gateway.js";
import type { MessageTracer } from "./messaging/message-tracer.js";
import type { SessionRepository } from "./session/session-repository.js";
import type { RuntimeApi } from "./session-coordinator/runtime-api.js";
import type { SessionInfoApi } from "./session-coordinator/session-info-api.js";
import type { SessionLifecycleService } from "./session-coordinator/session-lifecycle-service.js";

/** Core infra context threaded through all session services. */
export type BridgeCoreContext = {
  logger: Logger;
  config: ResolvedConfig;
  tracer: MessageTracer;
  gitResolver: GitInfoResolver | null;
  metrics: MetricsCollector | null;
};

export interface SessionServices {
  /** Resolved config, logger, tracer, gitResolver, metrics. */
  readonly core: BridgeCoreContext;
  /** Session data store. */
  readonly store: SessionRepository;
  /** Programmatic runtime operations (send, interrupt, slash commands, etc.). */
  readonly runtimeApi: RuntimeApi;
  /** Backend connector (connect/disconnect/query). */
  readonly backendConnector: BackendConnector;
  /** Capabilities handshake policy. */
  readonly capabilitiesPolicy: CapabilitiesPolicy;
  /** Session state reads and seeding. */
  readonly infoApi: SessionInfoApi;
  /** Session lifecycle (getOrCreate, close, remove). */
  readonly lifecycleService: SessionLifecycleService;
  /** Consumer WebSocket gateway (open/message/close). */
  readonly consumerGateway: ConsumerGateway;
  /** Broadcaster (needed by services that broadcast to all consumers). */
  readonly broadcaster: ConsumerBroadcaster;
}
