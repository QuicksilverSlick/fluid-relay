/**
 * SessionServices — flat registry of all services produced by the 4 compose planes.
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
import type { BackendApi } from "./bridge/backend-api.js";
import type { RuntimeApi } from "./bridge/runtime-api.js";
import type { SessionBroadcastApi } from "./bridge/session-broadcast-api.js";
import type { SessionInfoApi } from "./bridge/session-info-api.js";
import type { SessionLifecycleService } from "./bridge/session-lifecycle-service.js";
import type { SessionPersistenceService } from "./bridge/session-persistence-service.js";
import type { ConsumerBroadcaster } from "./consumer/consumer-broadcaster.js";
import type { ConsumerGateway } from "./consumer/consumer-gateway.js";
import type { MessageTracer } from "./messaging/message-tracer.js";
import type { SessionRepository } from "./session/session-repository.js";

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
  /** Backend connect/disconnect/query operations. */
  readonly backendApi: BackendApi;
  /** Session state reads and seeding. */
  readonly infoApi: SessionInfoApi;
  /** Broadcast operations (session_update, process output, watchdog, etc.). */
  readonly broadcastApi: SessionBroadcastApi;
  /** Session lifecycle (getOrCreate, close, remove). */
  readonly lifecycleService: SessionLifecycleService;
  /** Session persistence (restore, persist, persistSync). */
  readonly persistenceService: SessionPersistenceService;
  /** Consumer WebSocket gateway (open/message/close). */
  readonly consumerGateway: ConsumerGateway;
  /** Broadcaster (needed by services that broadcast to all consumers). */
  readonly broadcaster: ConsumerBroadcaster;
}
