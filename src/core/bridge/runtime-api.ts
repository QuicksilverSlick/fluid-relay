import type { Logger } from "../../interfaces/logger.js";
import type { WebSocketLike } from "../../interfaces/transport.js";
import type {
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
} from "../../types/cli-messages.js";
import type { InboundCommand, PolicyCommand } from "../interfaces/runtime-commands.js";
import type { SessionLeaseCoordinator } from "../session/session-lease-coordinator.js";
import type { Session, SessionRepository } from "../session/session-repository.js";
import type { UnifiedMessage } from "../types/unified-message.js";
import type { RuntimeManager } from "./runtime-manager.js";

export interface RuntimeApiOptions {
  store: SessionRepository;
  runtimeManager: RuntimeManager;
  logger: Logger;
  leaseCoordinator: SessionLeaseCoordinator;
  leaseOwnerId: string;
}

export class RuntimeApi {
  private readonly store: SessionRepository;
  private readonly runtimeManager: RuntimeManager;
  private readonly logger: Logger;
  private readonly leaseCoordinator: SessionLeaseCoordinator;
  private readonly leaseOwnerId: string;

  constructor(options: RuntimeApiOptions) {
    this.store = options.store;
    this.runtimeManager = options.runtimeManager;
    this.logger = options.logger;
    this.leaseCoordinator = options.leaseCoordinator;
    this.leaseOwnerId = options.leaseOwnerId;
  }

  sendUserMessage(
    sessionId: string,
    content: string,
    options?: {
      sessionIdOverride?: string;
      images?: { media_type: string; data: string }[];
      traceId?: string;
      slashRequestId?: string;
      slashCommand?: string;
    },
  ): void {
    this.withMutableSessionVoid(sessionId, "sendUserMessage", (session) =>
      this.runtime(session).sendUserMessage(content, options),
    );
  }

  sendPermissionResponse(
    sessionId: string,
    requestId: string,
    behavior: "allow" | "deny",
    options?: {
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: unknown[];
      message?: string;
    },
  ): void {
    this.withMutableSessionVoid(sessionId, "sendPermissionResponse", (session) =>
      this.runtime(session).sendPermissionResponse(requestId, behavior, options),
    );
  }

  sendInterrupt(sessionId: string): void {
    this.withMutableSessionVoid(sessionId, "sendInterrupt", (session) =>
      this.runtime(session).sendInterrupt(),
    );
  }

  sendSetModel(sessionId: string, model: string): void {
    this.withMutableSessionVoid(sessionId, "sendSetModel", (session) =>
      this.runtime(session).sendSetModel(model),
    );
  }

  sendSetPermissionMode(sessionId: string, mode: string): void {
    this.withMutableSessionVoid(sessionId, "sendSetPermissionMode", (session) =>
      this.runtime(session).sendSetPermissionMode(mode),
    );
  }

  getSupportedModels(sessionId: string): InitializeModel[] {
    return this.withSession(sessionId, [] as InitializeModel[], (session) =>
      this.runtime(session).getSupportedModels(),
    );
  }

  getSupportedCommands(sessionId: string): InitializeCommand[] {
    return this.withSession(sessionId, [] as InitializeCommand[], (session) =>
      this.runtime(session).getSupportedCommands(),
    );
  }

  getAccountInfo(sessionId: string): InitializeAccount | null {
    return this.withSession(sessionId, null, (session) => this.runtime(session).getAccountInfo());
  }

  async executeSlashCommand(
    sessionId: string,
    command: string,
  ): Promise<{ content: string; source: "emulated" } | null> {
    return this.withSession(sessionId, null, (session) =>
      this.runtime(session).executeSlashCommand(command),
    );
  }

  applyPolicyCommand(sessionId: string, command: PolicyCommand): void {
    this.withMutableSessionVoid(sessionId, "applyPolicyCommand", (session) =>
      this.runtime(session).handlePolicyCommand(command),
    );
  }

  handleInboundCommand(sessionId: string, msg: InboundCommand, ws: WebSocketLike): void {
    this.withMutableSessionVoid(sessionId, "handleInboundCommand", (session) =>
      this.runtime(session).handleInboundCommand(msg, ws),
    );
  }

  handleBackendMessage(sessionId: string, message: UnifiedMessage): void {
    this.withMutableSessionVoid(sessionId, "handleBackendMessage", (session) =>
      this.runtime(session).handleBackendMessage(message),
    );
  }

  handleLifecycleSignal(
    sessionId: string,
    signal: "backend:connected" | "backend:disconnected" | "session:closed",
  ): void {
    this.withMutableSessionVoid(sessionId, "handleLifecycleSignal", (session) =>
      this.runtime(session).handleSignal(signal),
    );
  }

  sendToBackend(sessionId: string, message: UnifiedMessage): void {
    this.withMutableSessionVoid(sessionId, "sendToBackend", (session) =>
      this.runtime(session).sendToBackend(message),
    );
  }

  private runtime(session: Session) {
    return this.runtimeManager.getOrCreate(session);
  }

  private withSession<T>(sessionId: string, onMissing: T, run: (session: Session) => T): T {
    const session = this.store.get(sessionId);
    if (!session) return onMissing;
    return run(session);
  }

  private withMutableSession<T>(
    sessionId: string,
    operation: string,
    onMissing: T,
    run: (session: Session) => T,
  ): T {
    const session = this.store.get(sessionId);
    if (!session) {
      if (operation === "sendToBackend") {
        this.logger.warn(`No backend session for ${sessionId}, cannot send message`);
      }
      return onMissing;
    }
    if (!this.leaseCoordinator.ensureLease(sessionId, this.leaseOwnerId)) {
      this.logger.warn("Session mutation blocked: lease not owned by this runtime", {
        sessionId,
        operation,
        leaseOwnerId: this.leaseOwnerId,
        currentLeaseOwner: this.leaseCoordinator.currentOwner(sessionId),
      });
      return onMissing;
    }
    return run(session);
  }

  private withMutableSessionVoid(
    sessionId: string,
    operation: string,
    run: (session: Session) => void,
  ): void {
    this.withMutableSession(sessionId, operation, undefined, (session) => run(session));
  }
}
