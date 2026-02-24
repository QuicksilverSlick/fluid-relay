/**
 * SessionRuntime — per-session state owner.
 *
 * Holds all mutable state for one session: message history, last status,
 * connected consumer set, queued message, and backend session reference.
 * Receives commands from SessionCoordinator and policy services; never
 * exposes raw state for external mutation. Delegates broadcasting to
 * ConsumerBroadcaster and does not emit domain events beyond its own
 * lifecycle transitions.
 */

import type { ConsumerIdentity } from "../../interfaces/auth.js";
import type { GitInfoResolver } from "../../interfaces/git-resolver.js";
import type { Logger } from "../../interfaces/logger.js";
import type { RateLimiter } from "../../interfaces/rate-limiter.js";
import type { WebSocketLike } from "../../interfaces/transport.js";
import type {
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
  PermissionRequest,
} from "../../types/cli-messages.js";

import type { BridgeEventMap } from "../../types/events.js";
import type { SessionSnapshot, SessionState } from "../../types/session-state.js";
import type { BackendConnector } from "../backend/backend-connector.js";
import type { CapabilitiesPolicy } from "../capabilities/capabilities-policy.js";
import type { ConsumerBroadcaster } from "../consumer/consumer-broadcaster.js";
import type { InboundCommand } from "../interfaces/runtime-commands.js";
import type { MessageTracer } from "../messaging/message-tracer.js";
import { tracedNormalizeInbound } from "../messaging/message-tracing-utils.js";
import type { SessionData } from "../session/session-data.js";
import type { SlashCommandService } from "../slash/slash-command-service.js";
import { diffTeamState } from "../team/team-event-differ.js";
import type { TeamState } from "../types/team-types.js";
import type { UnifiedMessage } from "../types/unified-message.js";
import { executeEffects } from "./effect-executor.js";
import type { GitInfoTracker } from "./git-info-tracker.js";
import type { MessageQueueHandler } from "./message-queue-handler.js";
import type { SessionEvent, SystemSignal } from "./session-event.js";
import type { LifecycleState } from "./session-lifecycle.js";
import { isLifecycleTransitionAllowed } from "./session-lifecycle.js";
import { sessionReducer } from "./session-reducer.js";
import type { Session, SessionRepository } from "./session-repository.js";

export type RuntimeTraceInfo = {
  traceId?: string;
  requestId?: string;
  command?: string;
};

export interface SessionRuntimeDeps {
  config: { maxMessageHistoryLength: number };
  broadcaster: Pick<
    ConsumerBroadcaster,
    "broadcast" | "broadcastToParticipants" | "broadcastPresence" | "sendTo"
  >;
  queueHandler: Pick<
    MessageQueueHandler,
    | "handleQueueMessage"
    | "handleUpdateQueuedMessage"
    | "handleCancelQueuedMessage"
    | "autoSendQueuedMessage"
  >;
  slashService: Pick<SlashCommandService, "handleInbound" | "executeProgrammatic">;
  backendConnector: Pick<BackendConnector, "sendToBackend">;
  tracer: MessageTracer;
  store: Pick<SessionRepository, "persist" | "persistSync">;
  logger: Logger;
  gitTracker: GitInfoTracker;
  gitResolver: GitInfoResolver | null;
  emitEvent: (type: string, payload: unknown) => void;
  capabilitiesPolicy: CapabilitiesPolicy;
}

type RuntimeSendUserMessageOptions = {
  sessionIdOverride?: string;
  images?: { media_type: string; data: string }[];
  traceId?: string;
  slashRequestId?: string;
  slashCommand?: string;
};

type RuntimeSendPermissionOptions = {
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: unknown[];
  message?: string;
};

export class SessionRuntime {
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private session: Session, // readonly removed — we reassign via spread
    private readonly deps: SessionRuntimeDeps,
  ) {
    this.hydrateSlashRegistryFromState();
  }

  /**
   * Schedule a persist after 50 ms — multiple rapid state changes collapse
   * into a single write.
   */
  private markDirty(): void {
    this.dirty = true;
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null;
        if (this.dirty) {
          this.dirty = false;
          this.deps.store.persist(this.session);
        }
      }, 50);
    }
  }

  /** Flush immediately — used for critical metadata changes (adapter name, user messages). */
  private persistNow(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.dirty = false;
    this.deps.store.persist(this.session);
  }

  getLifecycleState(): LifecycleState {
    return this.session.data.lifecycle;
  }

  // ── Single entry point ──────────────────────────────────────────────────

  /**
   * Process a session event — the single canonical entry point.
   *
   * All external stimuli (backend messages, consumer commands, policy
   * commands, lifecycle signals) flow through here. This gives us one
   * place to enforce mutation guards, timestamp activity, and dispatch.
   */
  process(event: SessionEvent): void {
    switch (event.type) {
      case "BACKEND_MESSAGE":
        this.handleBackendMessage(event.message);
        break;
      case "INBOUND_COMMAND":
        this.handleInboundCommand(event.command, event.ws);
        break;
      case "SYSTEM_SIGNAL":
        this.handleSystemSignal(event.signal);
        break;
    }
  }

  getSessionSnapshot(): SessionSnapshot {
    return {
      id: this.session.id,
      state: this.session.data.state,
      lifecycle: this.session.data.lifecycle,
      cliConnected: this.session.backendSession !== null,
      consumerCount: this.session.consumerSockets.size,
      consumers: Array.from(this.session.consumerSockets.values()).map((id) => ({
        userId: id.userId,
        displayName: id.displayName,
        role: id.role,
      })),
      pendingPermissions: Array.from(this.session.data.pendingPermissions.values()),
      messageHistoryLength: this.session.data.messageHistory.length,
      lastActivity: this.session.lastActivity,
      lastStatus: this.session.data.lastStatus,
    };
  }

  getSupportedModels(): InitializeModel[] {
    return this.session.data.state.capabilities?.models ?? [];
  }

  getSupportedCommands(): InitializeCommand[] {
    return this.session.data.state.capabilities?.commands ?? [];
  }

  getAccountInfo(): InitializeAccount | null {
    return this.session.data.state.capabilities?.account ?? null;
  }

  setAdapterName(name: string): void {
    this.session = {
      ...this.session,
      data: {
        ...this.session.data,
        adapterName: name,
        state: { ...this.session.data.state, adapterName: name },
      },
    };
    this.persistNow();
  }

  getLastStatus(): SessionData["lastStatus"] {
    return this.session.data.lastStatus;
  }

  getState(): SessionData["state"] {
    return this.session.data.state;
  }

  setLastStatus(status: SessionData["lastStatus"]): void {
    this.session = { ...this.session, data: { ...this.session.data, lastStatus: status } };
  }

  setState(state: SessionData["state"]): void {
    this.session = { ...this.session, data: { ...this.session.data, state } };
  }

  setBackendSessionId(sessionId: string | undefined): void {
    this.session = { ...this.session, data: { ...this.session.data, backendSessionId: sessionId } };
  }

  getMessageHistory(): SessionData["messageHistory"] {
    return this.session.data.messageHistory;
  }

  setMessageHistory(history: SessionData["messageHistory"]): void {
    this.session = { ...this.session, data: { ...this.session.data, messageHistory: history } };
  }

  getQueuedMessage(): SessionData["queuedMessage"] {
    return this.session.data.queuedMessage;
  }

  setQueuedMessage(queued: SessionData["queuedMessage"]): void {
    this.session = { ...this.session, data: { ...this.session.data, queuedMessage: queued } };
  }

  getPendingPermissions(): PermissionRequest[] {
    return Array.from(this.session.data.pendingPermissions.values());
  }

  getPendingInitialize(): Session["pendingInitialize"] {
    return this.session.pendingInitialize;
  }

  getConsumerIdentity(ws: WebSocketLike): ConsumerIdentity | undefined {
    return this.session.consumerSockets.get(ws);
  }

  getConsumerCount(): number {
    return this.session.consumerSockets.size;
  }

  getConsumerSockets(): ReadonlyMap<WebSocketLike, ConsumerIdentity> {
    return this.session.consumerSockets;
  }

  getBackendSession(): Session["backendSession"] {
    return this.session.backendSession;
  }

  getBackendAbort(): Session["backendAbort"] {
    return this.session.backendAbort;
  }

  isBackendConnected(): boolean {
    return this.session.backendSession !== null;
  }

  setPendingInitialize(pendingInitialize: Session["pendingInitialize"]): void {
    this.session.pendingInitialize = pendingInitialize;
  }

  trySendRawToBackend(ndjson: string): "sent" | "unsupported" | "no_backend" {
    const backendSession = this.session.backendSession;
    if (!backendSession) return "no_backend";
    try {
      backendSession.sendRaw(ndjson);
      return "sent";
    } catch {
      return "unsupported";
    }
  }

  registerCLICommands(commands: InitializeCommand[]): void {
    this.session.registry.registerFromCLI?.(commands);
  }

  registerSlashCommandNames(commands: string[]): void {
    if (commands.length === 0) return;
    this.registerCLICommands(commands.map((name) => ({ name, description: "" })));
  }

  registerSkillCommands(skills: string[]): void {
    if (skills.length === 0) return;
    this.session.registry.registerSkills?.(skills);
  }

  clearDynamicSlashRegistry(): void {
    this.session.registry.clearDynamic?.();
  }

  seedSessionState(params: { cwd?: string; model?: string }): void {
    const patch: Partial<SessionData["state"]> = {};
    if (params.cwd) patch.cwd = params.cwd;
    if (params.model) patch.model = params.model;
    if (Object.keys(patch).length > 0) {
      this.session = {
        ...this.session,
        data: { ...this.session.data, state: { ...this.session.data.state, ...patch } },
      };
    }
    this.deps.gitTracker.resolveGitInfo(this.session);
  }

  allocateAnonymousIdentityIndex(): number {
    this.session.anonymousCounter += 1;
    return this.session.anonymousCounter;
  }

  addConsumer(ws: WebSocketLike, identity: ConsumerIdentity): void {
    this.session.consumerSockets.set(ws, identity);
  }

  removeConsumer(ws: WebSocketLike): ConsumerIdentity | undefined {
    const identity = this.session.consumerSockets.get(ws);
    this.session.consumerSockets.delete(ws);
    this.session.consumerRateLimiters.delete(ws);
    return identity;
  }

  closeAllConsumers(): void {
    for (const ws of this.session.consumerSockets.keys()) {
      try {
        ws.close();
      } catch {
        // Ignore close errors for defensive shutdown.
      }
      this.removeConsumer(ws);
    }
  }

  async closeBackendConnection(): Promise<void> {
    const backendSession = this.session.backendSession;
    if (!backendSession) return;
    this.session.backendAbort?.abort();
    await backendSession.close();
    this.clearBackendConnection();
  }

  clearBackendConnection(): void {
    this.session.backendSession = null;
    this.session.backendAbort = null;
  }

  attachBackendConnection(params: {
    backendSession: NonNullable<Session["backendSession"]>;
    backendAbort: AbortController;
    supportsSlashPassthrough: boolean;
    slashExecutor: Session["adapterSlashExecutor"] | null;
  }): void {
    this.session.backendSession = params.backendSession;
    this.session.backendAbort = params.backendAbort;
    this.session.adapterSlashExecutor = params.slashExecutor;
    this.session = {
      ...this.session,
      data: {
        ...this.session.data,
        adapterSupportsSlashPassthrough: params.supportsSlashPassthrough,
      },
    };
  }

  resetBackendConnectionState(): void {
    this.clearBackendConnection();
    this.session = {
      ...this.session,
      data: {
        ...this.session.data,
        backendSessionId: undefined,
        adapterSupportsSlashPassthrough: false,
      },
    };
    this.session.adapterSlashExecutor = null;
  }

  drainPendingMessages(): UnifiedMessage[] {
    const pending = Array.from(this.session.data.pendingMessages);
    this.session = { ...this.session, data: { ...this.session.data, pendingMessages: [] } };
    return pending;
  }

  drainPendingPermissionIds(): string[] {
    const ids = Array.from(this.session.data.pendingPermissions.keys());
    this.session = {
      ...this.session,
      data: { ...this.session.data, pendingPermissions: new Map() },
    };
    return ids;
  }

  storePendingPermission(requestId: string, request: PermissionRequest): void {
    const updated = new Map(this.session.data.pendingPermissions);
    updated.set(requestId, request);
    this.session = { ...this.session, data: { ...this.session.data, pendingPermissions: updated } };
  }

  enqueuePendingPassthrough(entry: Session["pendingPassthroughs"][number]): void {
    this.session.pendingPassthroughs.push(entry);
  }

  peekPendingPassthrough(): Session["pendingPassthroughs"][number] | undefined {
    return this.session.pendingPassthroughs[0];
  }

  shiftPendingPassthrough(): Session["pendingPassthroughs"][number] | undefined {
    return this.session.pendingPassthroughs.shift();
  }

  checkRateLimit(ws: WebSocketLike, createLimiter: () => RateLimiter | undefined): boolean {
    let limiter = this.session.consumerRateLimiters.get(ws);
    if (!limiter) {
      limiter = createLimiter();
      if (!limiter) return true;
      this.session.consumerRateLimiters.set(ws, limiter);
    }
    return limiter.tryConsume();
  }

  transitionLifecycle(next: LifecycleState, reason: string): boolean {
    const current = this.session.data.lifecycle;
    if (current === next) return true;
    if (!isLifecycleTransitionAllowed(current, next)) {
      this.deps.logger.warn("Session lifecycle invalid transition", {
        sessionId: this.session.id,
        current,
        next,
        reason,
      });
      return false;
    }
    this.session = { ...this.session, data: { ...this.session.data, lifecycle: next } };
    return true;
  }

  private handleInboundCommand(msg: InboundCommand, ws: WebSocketLike): void {
    this.touchActivity();
    switch (msg.type) {
      case "user_message": {
        // Route pure state mutations (lastStatus + messageHistory) through the reducer.
        const prevData = this.session.data;
        const [nextData, effects] = sessionReducer(
          this.session.data,
          { type: "INBOUND_COMMAND", command: msg, ws },
          this.deps.config,
        );
        if (nextData !== prevData) {
          // Reducer accepted the message — apply state + effects, then do I/O.
          this.session = { ...this.session, data: nextData };
          executeEffects(effects, this.session, this.effectDeps());
          this.sendUserMessageIO(msg.content, {
            sessionIdOverride: msg.session_id,
            images: msg.images,
          });
        } else {
          // Lifecycle is closed/closing — send targeted error to the requesting consumer.
          this.deps.broadcaster.sendTo(ws, {
            type: "error",
            message: "Session is closing or closed and cannot accept new messages.",
          });
        }
        break;
      }
      case "permission_response":
        this.sendPermissionResponse(msg.request_id, msg.behavior, {
          updatedInput: msg.updated_input,
          updatedPermissions: msg.updated_permissions,
          message: msg.message,
        });
        break;
      case "interrupt":
        this.sendInterrupt();
        break;
      case "set_model":
        this.sendSetModel(msg.model);
        break;
      case "set_permission_mode":
        this.sendSetPermissionMode(msg.mode);
        break;
      case "presence_query":
        this.deps.broadcaster.broadcastPresence(this.session);
        break;
      case "slash_command":
        this.handleSlashCommand(msg);
        break;
      case "queue_message":
        this.deps.queueHandler.handleQueueMessage(this.session, msg, ws);
        break;
      case "update_queued_message":
        this.deps.queueHandler.handleUpdateQueuedMessage(this.session, msg, ws);
        break;
      case "cancel_queued_message":
        this.deps.queueHandler.handleCancelQueuedMessage(this.session, ws);
        break;
      case "set_adapter":
        this.deps.broadcaster.sendTo(ws, {
          type: "error",
          message:
            "Adapter cannot be changed on an active session. Create a new session with the desired adapter.",
        });
        break;
    }
  }

  /**
   * Send a user message: applies pure state mutations via the reducer, then
   * executes I/O (backend send or queue). Returns `false` if the session
   * lifecycle rejected the message (closed/closing).
   */
  sendUserMessage(content: string, options?: RuntimeSendUserMessageOptions): boolean {
    const prevData = this.session.data;
    const [nextData, effects] = sessionReducer(
      this.session.data,
      {
        type: "INBOUND_COMMAND",
        command: { type: "user_message", content, session_id: options?.sessionIdOverride ?? "" },
        ws: null as never, // ws not needed for pure state mutations
      },
      this.deps.config,
    );

    if (nextData === prevData) {
      // Lifecycle is closed/closing — message rejected.
      return false;
    }

    this.session = { ...this.session, data: nextData };
    executeEffects(effects, this.session, this.effectDeps());
    return this.sendUserMessageIO(content, options);
  }

  /**
   * I/O side of user message handling: normalizes the message, transitions
   * the lifecycle, sends to backend (or queues it), and persists.
   * Called after the reducer has already applied the pure state mutations.
   * Returns `false` if the lifecycle transition was rejected.
   */
  private sendUserMessageIO(content: string, options?: RuntimeSendUserMessageOptions): boolean {
    const unified = tracedNormalizeInbound(
      this.deps.tracer,
      {
        type: "user_message",
        content,
        session_id: options?.sessionIdOverride || this.session.data.backendSessionId || "",
        images: options?.images,
      },
      this.session.id,
      {
        traceId: options?.traceId,
        requestId: options?.slashRequestId,
        command: options?.slashCommand,
      },
    );
    if (!unified) return true;

    const backendSession = this.session.backendSession;
    const lifecycleTransitioned = backendSession
      ? this.transitionLifecycle("active", "inbound:user_message")
      : this.transitionLifecycle("awaiting_backend", "inbound:user_message:queued");
    if (!lifecycleTransitioned) {
      return false;
    }

    if (backendSession) {
      backendSession.send(unified);
    } else {
      this.session = {
        ...this.session,
        data: {
          ...this.session.data,
          pendingMessages: [...this.session.data.pendingMessages, unified],
        },
      };
    }
    this.persistNow();
    return true;
  }

  sendPermissionResponse(
    requestId: string,
    behavior: "allow" | "deny",
    options?: RuntimeSendPermissionOptions,
  ): void {
    const pending = this.session.data.pendingPermissions.get(requestId);
    if (!pending) {
      this.deps.logger.warn(
        `Permission response for unknown request_id ${requestId} in session ${this.session.id}`,
      );
      return;
    }
    const updatedPerms = new Map(this.session.data.pendingPermissions);
    updatedPerms.delete(requestId);
    this.session = {
      ...this.session,
      data: { ...this.session.data, pendingPermissions: updatedPerms },
    };
    this.deps.emitEvent("permission:resolved", {
      sessionId: this.session.id,
      requestId,
      behavior,
    });

    if (!this.session.backendSession) return;
    const unified = tracedNormalizeInbound(
      this.deps.tracer,
      {
        type: "permission_response",
        request_id: requestId,
        behavior,
        updated_input: options?.updatedInput,
        updated_permissions: options?.updatedPermissions as
          | import("../../types/cli-messages.js").PermissionUpdate[]
          | undefined,
        message: options?.message,
      },
      this.session.id,
    );
    if (unified) {
      this.session.backendSession.send(unified);
    }
  }

  sendInterrupt(): void {
    this.sendControlRequest({ type: "interrupt" });
  }

  sendSetModel(model: string): void {
    if (!this.session.backendSession) return;
    // Route pure state mutation (state.model + BROADCAST_SESSION_UPDATE) through reducer.
    const [nextData, effects] = sessionReducer(
      this.session.data,
      {
        type: "INBOUND_COMMAND",
        command: { type: "set_model", model },
        ws: null as never, // ws not needed for pure state mutations
      },
      this.deps.config,
    );
    if (nextData !== this.session.data) {
      this.session = { ...this.session, data: nextData };
      executeEffects(effects, this.session, this.effectDeps());
    }
    this.sendControlRequest({ type: "set_model", model });
  }

  sendSetPermissionMode(mode: string): void {
    this.sendControlRequest({ type: "set_permission_mode", mode });
  }

  private effectDeps() {
    return {
      broadcaster: this.deps.broadcaster,
      emitEvent: this.deps.emitEvent,
      queueHandler: this.deps.queueHandler,
      backendConnector: this.deps.backendConnector,
      store: this.deps.store,
    };
  }

  private handleSystemSignal(signal: SystemSignal): void {
    const prevData = this.session.data;
    const [nextData, effects] = sessionReducer(
      this.session.data,
      { type: "SYSTEM_SIGNAL", signal },
      this.deps.config,
    );
    if (nextData !== prevData) {
      this.session = { ...this.session, data: nextData };
      this.markDirty();
    }
    executeEffects(effects, this.session, this.effectDeps());
  }

  async executeSlashCommand(
    command: string,
  ): Promise<{ content: string; source: "emulated" } | null> {
    return this.deps.slashService.executeProgrammatic(this.session, command);
  }

  sendToBackend(message: UnifiedMessage): void {
    this.deps.backendConnector.sendToBackend(this.session, message);
  }

  private sendControlRequest(msg: InboundCommand): void {
    if (!this.session.backendSession) return;
    const unified = tracedNormalizeInbound(this.deps.tracer, msg, this.session.id);
    if (unified) {
      this.session.backendSession.send(unified);
    }
  }

  private handleBackendMessage(msg: UnifiedMessage): void {
    this.touchActivity();

    const prevData = this.session.data;
    const [nextData, effects] = sessionReducer(
      this.session.data,
      { type: "BACKEND_MESSAGE", message: msg },
      this.deps.config,
    );

    if (nextData !== this.session.data) {
      this.session = { ...this.session, data: nextData };
      this.markDirty();
    }

    // Execute reducer effects (T4 broadcasts + event emissions + queue flush)
    executeEffects(effects, this.session, this.effectDeps());

    // High-level orchestration for complex side effects
    if (msg.type === "session_init") {
      this.orchestrateSessionInit(msg);
    } else if (msg.type === "result") {
      this.orchestrateResult(msg);
    } else if (msg.type === "control_response") {
      this.orchestrateControlResponse(msg);
    }

    this.emitTeamEvents(prevData.state.team);

    this.applyLifecycleFromBackendMessage(msg);
  }

  private orchestrateSessionInit(msg: UnifiedMessage): void {
    const m = msg.metadata;

    // Store backend session ID for resume
    if (m.session_id) {
      this.deps.emitEvent("backend:session_id", {
        sessionId: this.session.id,
        backendSessionId: m.session_id as string,
      });
    }

    // Resolve git info
    this.deps.gitTracker.resetAttempt(this.session.id);
    if (this.session.data.state.cwd && this.deps.gitResolver) {
      const gitInfo = this.deps.gitResolver.resolve(this.session.data.state.cwd);
      if (gitInfo) {
        this.session = {
          ...this.session,
          data: {
            ...this.session.data,
            state: { ...this.session.data.state, ...gitInfo },
          },
        };
      }
    }

    // Populate registry from init data
    this.clearDynamicSlashRegistry();
    const state = this.session.data.state;
    if (state.slash_commands.length > 0) {
      this.registerSlashCommandNames(state.slash_commands);
    }
    if (state.skills.length > 0) {
      this.registerSkillCommands(state.skills);
    }

    // Initialize capabilities policy
    if (m.capabilities && typeof m.capabilities === "object") {
      const caps = m.capabilities as {
        commands?: InitializeCommand[];
        models?: InitializeModel[];
        account?: InitializeAccount;
      };
      this.deps.capabilitiesPolicy.applyCapabilities(
        this.session,
        Array.isArray(caps.commands) ? caps.commands : [],
        Array.isArray(caps.models) ? caps.models : [],
        caps.account ?? null,
      );
    } else {
      this.deps.capabilitiesPolicy.sendInitializeRequest(this.session);
    }
  }

  private orchestrateControlResponse(msg: UnifiedMessage): void {
    const sessionBefore = this.session;
    this.deps.capabilitiesPolicy.handleControlResponse(this.session, msg);
    // handleControlResponse may mutate this.session via stateAccessors.setState;
    // persist the new snapshot if it changed.
    if (this.session !== sessionBefore) {
      this.markDirty();
    }
  }

  private orchestrateResult(_msg: UnifiedMessage): void {
    // Re-resolve git info (first-turn event + auto-send handled by effects)
    const gitUpdate = this.deps.gitTracker.refreshGitInfo(this.session);
    if (gitUpdate) {
      this.session = {
        ...this.session,
        data: {
          ...this.session.data,
          state: { ...this.session.data.state, ...gitUpdate },
        },
      };
      // Broadcast update to consumers
      this.deps.broadcaster.broadcast(this.session, {
        type: "session_update",
        session: gitUpdate,
      });
    }
  }

  private emitTeamEvents(prevTeam: TeamState | undefined): void {
    const currentTeam = this.session.data.state.team;
    if (prevTeam === currentTeam) return;

    // Broadcast team update
    this.deps.broadcaster.broadcast(this.session, {
      type: "session_update",
      session: { team: currentTeam ?? null } as Partial<SessionState>,
    });

    // Diff and emit internal events
    const events = diffTeamState(this.session.id, prevTeam, currentTeam);
    for (const event of events) {
      this.deps.emitEvent(event.type, event.payload as BridgeEventMap[keyof BridgeEventMap]);
    }
  }

  private handleSlashCommand(msg: Extract<InboundCommand, { type: "slash_command" }>): void {
    this.deps.slashService.handleInbound(this.session, msg);
  }

  private applyLifecycleFromBackendMessage(msg: UnifiedMessage): void {
    if (msg.type === "status_change") {
      const status = typeof msg.metadata.status === "string" ? msg.metadata.status : null;
      if (status === "idle") {
        this.transitionLifecycle("idle", "backend:status_change:idle");
      } else if (status === "running" || status === "compacting") {
        this.transitionLifecycle("active", `backend:status_change:${status}`);
      }
      return;
    }

    if (msg.type === "result") {
      this.transitionLifecycle("idle", "backend:result");
      return;
    }

    if (msg.type === "stream_event") {
      const event = msg.metadata.event as { type?: unknown } | undefined;
      if (event?.type === "message_start" && !msg.metadata.parent_tool_use_id) {
        this.transitionLifecycle("active", "backend:stream_event:message_start");
      }
    }
  }

  private touchActivity(): void {
    this.session.lastActivity = Date.now();
  }

  private hydrateSlashRegistryFromState(): void {
    this.clearDynamicSlashRegistry();
    this.registerSlashCommandNames(this.session.data.state.slash_commands ?? []);
    this.registerSkillCommands(this.session.data.state.skills ?? []);
  }
}
