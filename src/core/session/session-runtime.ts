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

import type { SessionSnapshot } from "../../types/session-state.js";
import type { BackendConnector } from "../backend/backend-connector.js";
import type { CapabilitiesPolicy } from "../capabilities/capabilities-policy.js";
import type { ConsumerBroadcaster } from "../consumer/consumer-broadcaster.js";
import type { InboundCommand } from "../interfaces/runtime-commands.js";
import { normalizeInbound } from "../messaging/inbound-normalizer.js";
import type { MessageTracer } from "../messaging/message-tracer.js";
import type { SessionData } from "../session/session-data.js";
import type { SlashCommandService } from "../slash/slash-command-service.js";
import type { TeamState } from "../types/team-types.js";
import type { UnifiedMessage } from "../types/unified-message.js";
import { executeEffects } from "./effect-executor.js";
import { applyGitInfo, type GitInfoTracker } from "./git-info-tracker.js";
import type { MessageQueueHandler } from "./message-queue-handler.js";
import type { SessionEvent, SystemSignal } from "./session-event.js";
import type { LifecycleState } from "./session-lifecycle.js";
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

  getLastStatus(): SessionData["lastStatus"] {
    return this.session.data.lastStatus;
  }

  getState(): SessionData["state"] {
    return this.session.data.state;
  }

  getMessageHistory(): SessionData["messageHistory"] {
    return this.session.data.messageHistory;
  }

  getQueuedMessage(): SessionData["queuedMessage"] {
    return this.session.data.queuedMessage;
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
    if (
      !("sendRaw" in backendSession) ||
      typeof (backendSession as unknown as Record<string, unknown>).sendRaw !== "function"
    ) {
      return "unsupported";
    }
    (backendSession as unknown as { sendRaw: (s: string) => void }).sendRaw(ndjson);
    return "sent";
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

  allocateAnonymousIdentityIndex(): number {
    this.session.anonymousCounter += 1;
    return this.session.anonymousCounter;
  }

  closeAllConsumers(): void {
    for (const ws of this.session.consumerSockets.keys()) {
      try {
        ws.close();
      } catch {
        // Ignore close errors for defensive shutdown.
      }
    }
    this.session.consumerSockets.clear();
    this.session.consumerRateLimiters.clear();
  }

  async closeBackendConnection(): Promise<void> {
    const backendSession = this.session.backendSession;
    if (!backendSession) return;
    this.session.backendAbort?.abort();
    await backendSession.close();
    // Dispatch BACKEND_DISCONNECTED so the reducer cancels pending permissions
    // and the post-reducer hook nulls the handles.
    this.process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "BACKEND_DISCONNECTED", reason: "session_closed" },
    });
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

  private handleInboundCommand(msg: InboundCommand, ws: WebSocketLike): void {
    this.touchActivity();
    switch (msg.type) {
      case "user_message": {
        const accepted = this.applyUserMessageReducer(msg.content, {
          sessionIdOverride: msg.session_id,
          images: msg.images,
        });
        if (!accepted) {
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
    return this.applyUserMessageReducer(content, options);
  }

  /**
   * Shared reducer + I/O path for user messages.
   * Used by both handleInboundCommand (WebSocket path) and sendUserMessage (programmatic path).
   * Returns `false` if the session lifecycle rejected the message.
   */
  private applyUserMessageReducer(
    content: string,
    options?: RuntimeSendUserMessageOptions,
  ): boolean {
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
      return false;
    }

    this.session = { ...this.session, data: nextData };
    executeEffects(effects, this.session, this.effectDeps());
    return this.sendUserMessageIO(content, options);
  }

  /**
   * I/O side of user message handling: normalizes the message, sends to
   * backend (or queues it via PENDING_MESSAGE_ADDED signal).
   * Called after the reducer has already applied the pure state mutations
   * (lastStatus, lifecycle, messageHistory).
   */
  private sendUserMessageIO(content: string, options?: RuntimeSendUserMessageOptions): boolean {
    const unified = normalizeInbound({
      type: "user_message",
      content,
      session_id: options?.sessionIdOverride || this.session.data.backendSessionId || "",
      images: options?.images,
    });
    if (!unified) {
      this.deps.logger.error("normalizeInbound returned null for user_message — message dropped", {
        sessionId: this.session.id,
        contentLength: content.length,
      });
      return true;
    }
    if (options?.traceId) unified.metadata.trace_id = options.traceId;
    if (options?.slashRequestId) unified.metadata.slash_request_id = options.slashRequestId;
    if (options?.slashCommand) unified.metadata.slash_command = options.slashCommand;

    if (this.session.backendSession) {
      executeEffects(
        [{ type: "SEND_TO_BACKEND", message: unified }],
        this.session,
        this.effectDeps(),
      );
    } else {
      this.process({
        type: "SYSTEM_SIGNAL",
        signal: { kind: "PENDING_MESSAGE_ADDED", message: unified },
      });
    }
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
    this.process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "PERMISSION_RESOLVED", requestId, behavior },
    });

    const unified = normalizeInbound({
      type: "permission_response",
      request_id: requestId,
      behavior,
      updated_input: options?.updatedInput,
      updated_permissions: options?.updatedPermissions as
        | import("../../types/cli-messages.js").PermissionUpdate[]
        | undefined,
      message: options?.message,
    });
    if (!unified) {
      this.deps.logger.error(
        "normalizeInbound returned null for permission_response — response dropped",
        { sessionId: this.session.id, requestId },
      );
      return;
    }
    executeEffects(
      [{ type: "SEND_TO_BACKEND", message: unified }],
      this.session,
      this.effectDeps(),
    );
  }

  sendInterrupt(): void {
    this.sendControlRequest({ type: "interrupt" });
  }

  sendSetModel(model: string): void {
    if (!this.session.backendSession) return;
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
      gitTracker: this.deps.gitTracker,
      tracer: this.deps.tracer,
    };
  }

  /**
   * Apply a SystemSignal to session state and execute the resulting effects.
   *
   * Three-phase execution:
   *   1. Run sessionReducer — pure data mutations and effect list (no I/O).
   *   2. Apply BACKEND_CONNECTED handle refs BEFORE effects so that
   *      SEND_TO_BACKEND effects (drained pending messages) can reach the
   *      now-live BackendSession.
   *   3. Execute effects via executeEffects().
   *   4. Apply remaining handle mutations AFTER effects:
   *      BACKEND_DISCONNECTED, CONSUMER_CONNECTED/DISCONNECTED, PASSTHROUGH_ENQUEUED.
   *      These mutate non-serializable handles (outside SessionData) that are
   *      not needed by the effects they accompany.
   */
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

    // Apply BACKEND_CONNECTED handle mutations BEFORE executing effects so that
    // SEND_TO_BACKEND effects (drained pending messages) can reach the backend session.
    if (signal.kind === "BACKEND_CONNECTED") {
      this.session.backendSession = signal.backendSession;
      this.session.backendAbort = signal.backendAbort;
      this.session.adapterSlashExecutor = signal.slashExecutor;
    }

    executeEffects(effects, this.session, this.effectDeps());

    // Post-reducer handle mutations — these fields are NOT part of SessionData
    // and are NOT persisted. Only non-serializable handles (WebSocket, AbortController,
    // BackendSession) belong here. Serializable state must go through the reducer → markDirty().
    switch (signal.kind) {
      case "BACKEND_DISCONNECTED":
        this.session.backendSession = null;
        this.session.backendAbort = null;
        this.session.adapterSlashExecutor = null;
        break;
      case "CONSUMER_CONNECTED":
        this.session.consumerSockets.set(signal.ws, signal.identity);
        this.deps.emitEvent("consumer:authenticated", {
          sessionId: this.session.id,
          userId: signal.identity.userId,
          displayName: signal.identity.displayName,
          role: signal.identity.role,
        });
        this.deps.emitEvent("consumer:connected", {
          sessionId: this.session.id,
          consumerCount: this.session.consumerSockets.size,
          identity: signal.identity,
        });
        break;
      case "CONSUMER_DISCONNECTED": {
        const disconnectedIdentity = this.session.consumerSockets.get(signal.ws);
        this.session.consumerSockets.delete(signal.ws);
        this.session.consumerRateLimiters.delete(signal.ws);
        this.deps.emitEvent("consumer:disconnected", {
          sessionId: this.session.id,
          consumerCount: this.session.consumerSockets.size,
          identity: disconnectedIdentity,
        });
        break;
      }
      case "PASSTHROUGH_ENQUEUED":
        this.session.pendingPassthroughs.push(signal.entry);
        break;
    }
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
    const unified = normalizeInbound(msg);
    if (!unified) {
      this.deps.logger.error(
        "normalizeInbound returned null for control request — request dropped",
        {
          sessionId: this.session.id,
          msgType: msg.type,
        },
      );
      return;
    }
    executeEffects(
      [{ type: "SEND_TO_BACKEND", message: unified }],
      this.session,
      this.effectDeps(),
    );
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
        const { git_branch, is_worktree, repo_root, git_ahead, git_behind } = applyGitInfo(
          this.session.data.state,
          gitInfo,
        );
        this.process({
          type: "SYSTEM_SIGNAL",
          signal: {
            kind: "STATE_PATCHED",
            patch: { git_branch, is_worktree, repo_root, git_ahead, git_behind },
          },
        });
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
    // refreshGitInfo already calls patchState → process(STATE_PATCHED) internally.
    const gitUpdate = this.deps.gitTracker.refreshGitInfo(this.session);
    if (gitUpdate) {
      this.process({
        type: "SYSTEM_SIGNAL",
        signal: { kind: "STATE_PATCHED", patch: gitUpdate, broadcast: true },
      });
    }
  }

  private emitTeamEvents(prevTeam: TeamState | undefined): void {
    const currentTeam = this.session.data.state.team;
    if (prevTeam === currentTeam) return;
    this.process({
      type: "SYSTEM_SIGNAL",
      signal: {
        kind: "TEAM_STATE_DIFFED",
        prevTeam,
        currentTeam,
        sessionId: this.session.id,
      },
    });
  }

  private handleSlashCommand(msg: Extract<InboundCommand, { type: "slash_command" }>): void {
    this.deps.slashService.handleInbound(this.session, msg);
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
