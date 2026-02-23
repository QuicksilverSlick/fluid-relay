import type { Logger } from "../../interfaces/logger.js";
import type { MetricsCollector } from "../../interfaces/metrics.js";
import type { CapabilitiesPolicy } from "../capabilities/capabilities-policy.js";
import type { SessionLeaseCoordinator } from "../session/session-lease-coordinator.js";
import type { Session, SessionRepository } from "../session/session-repository.js";
import type { SessionRuntime } from "../session/session-runtime.js";
import type { RuntimeManager } from "./runtime-manager.js";

export interface SessionLifecycleServiceOptions {
  store: SessionRepository;
  runtimeManager: RuntimeManager;
  capabilitiesPolicy: CapabilitiesPolicy;
  metrics: MetricsCollector | null;
  logger: Logger;
  emitSessionClosed: (sessionId: string) => void;
  leaseCoordinator?: SessionLeaseCoordinator;
  leaseOwnerId?: string;
}

/**
 * Owns session lifecycle operations previously implemented in SessionBridge.
 * Keeps bridge API stable while reducing orchestration coupling.
 */
export class SessionLifecycleService {
  private readonly store: SessionRepository;
  private readonly runtimeManager: RuntimeManager;
  private readonly capabilitiesPolicy: CapabilitiesPolicy;
  private readonly metrics: MetricsCollector | null;
  private readonly logger: Logger;
  private readonly emitSessionClosed: (sessionId: string) => void;
  private readonly leaseCoordinator: SessionLeaseCoordinator | null;
  private readonly leaseOwnerId: string | null;

  constructor(options: SessionLifecycleServiceOptions) {
    this.store = options.store;
    this.runtimeManager = options.runtimeManager;
    this.capabilitiesPolicy = options.capabilitiesPolicy;
    this.metrics = options.metrics;
    this.logger = options.logger;
    this.emitSessionClosed = options.emitSessionClosed;
    this.leaseCoordinator = options.leaseCoordinator ?? null;
    this.leaseOwnerId = options.leaseOwnerId ?? null;
  }

  getOrCreateSession(sessionId: string): Session {
    if (
      this.leaseCoordinator &&
      this.leaseOwnerId &&
      !this.leaseCoordinator.ensureLease(sessionId, this.leaseOwnerId)
    ) {
      this.logger.warn("Session lifecycle getOrCreate blocked: lease not owned by this runtime", {
        sessionId,
        leaseOwnerId: this.leaseOwnerId,
        currentLeaseOwner: this.leaseCoordinator.currentOwner(sessionId),
      });
      throw new Error(`Session lease for ${sessionId} is owned by another runtime`);
    }

    const existed = this.store.has(sessionId);
    const session = this.store.getOrCreate(sessionId);
    this.runtime(session);
    if (!existed) {
      this.metrics?.recordEvent({
        timestamp: Date.now(),
        type: "session:created",
        sessionId,
      });
    }
    return session;
  }

  removeSession(sessionId: string): void {
    const session = this.store.get(sessionId);
    if (session) {
      this.capabilitiesPolicy.cancelPendingInitialize(session);
    }
    this.runtimeManager.delete(sessionId);
    this.store.remove(sessionId);
    if (this.leaseCoordinator && this.leaseOwnerId) {
      this.leaseCoordinator.releaseLease(sessionId, this.leaseOwnerId);
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session) return;
    const runtime = this.runtime(session);
    runtime.transitionLifecycle("closing", "session:close");

    this.capabilitiesPolicy.cancelPendingInitialize(session);

    // Close backend session and await it so the subprocess is fully terminated
    // before the caller proceeds (prevents port-reuse races in sequential tests).
    if (runtime.getBackendSession()) {
      await runtime.closeBackendConnection().catch((err) => {
        this.logger.warn("Failed to close backend session", { sessionId: session.id, error: err });
      });
    }

    runtime.closeAllConsumers();
    runtime.process({ type: "LIFECYCLE_SIGNAL", signal: "session:closed" });

    this.store.remove(sessionId);
    this.runtimeManager.delete(sessionId);
    if (this.leaseCoordinator && this.leaseOwnerId) {
      this.leaseCoordinator.releaseLease(sessionId, this.leaseOwnerId);
    }
    this.metrics?.recordEvent({
      timestamp: Date.now(),
      type: "session:closed",
      sessionId,
    });
    this.emitSessionClosed(sessionId);
  }

  async closeAllSessions(): Promise<void> {
    await Promise.allSettled(Array.from(this.store.keys()).map((id) => this.closeSession(id)));
    this.runtimeManager.clear();
  }

  private runtime(session: Session): SessionRuntime {
    return this.runtimeManager.getOrCreate(session);
  }
}
