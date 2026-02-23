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
import type { RateLimiter } from "../../interfaces/rate-limiter.js";
import type { WebSocketLike } from "../../interfaces/transport.js";
import type {
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
  PermissionRequest,
} from "../../types/cli-messages.js";
import type { ConsumerMessage } from "../../types/consumer-messages.js";
import type { BridgeEventMap } from "../../types/events.js";
import type { SessionSnapshot, SessionState } from "../../types/session-state.js";
import type { CapabilitiesPolicy } from "../capabilities/capabilities-policy.js";
import type { ConsumerBroadcaster } from "../consumer/consumer-broadcaster.js";
import type { InboundCommand, PolicyCommand } from "../interfaces/runtime-commands.js";
import type { SessionData } from "../session/session-data.js";
import type { SlashCommandService } from "../slash/slash-command-service.js";
import { diffTeamState } from "../team/team-event-differ.js";
import type { TeamState } from "../types/team-types.js";
import type { UnifiedMessage } from "../types/unified-message.js";
import { executeEffects } from "./effect-executor.js";
import type { GitInfoTracker } from "./git-info-tracker.js";
import type { MessageQueueHandler } from "./message-queue-handler.js";
import type { LifecycleState } from "./session-lifecycle.js";
import { isLifecycleTransitionAllowed } from "./session-lifecycle.js";
import type { Session } from "./session-repository.js";
import { reduceSessionData } from "./session-state-reducer.js";

export type RuntimeTraceInfo = {
  traceId?: string;
  requestId?: string;
  command?: string;
};

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

export interface SessionRuntimeDeps {
  now: () => number;
  maxMessageHistoryLength: number;
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

  sendToBackend: (session: Session, message: UnifiedMessage) => void;
  tracedNormalizeInbound: (
    session: Session,
    msg: InboundCommand,
    trace?: RuntimeTraceInfo,
  ) => UnifiedMessage | null;
  persistSession: (session: Session) => void;
  warnUnknownPermission: (sessionId: string, requestId: string) => void;
  emitPermissionResolved: (
    sessionId: string,
    requestId: string,
    behavior: "allow" | "deny",
  ) => void;
  onSessionSeeded?: (session: Session) => void;
  onInvalidLifecycleTransition?: (params: {
    sessionId: string;
    from: LifecycleState;
    to: LifecycleState;
    reason: string;
  }) => void;
  onInboundObserved?: (session: Session, msg: InboundCommand) => void;
  onInboundHandled?: (session: Session, msg: InboundCommand) => void;
  onBackendMessageObserved?: (session: Session, msg: UnifiedMessage) => void;
  onBackendMessageHandled?: (session: Session, msg: UnifiedMessage) => void;
  onSignal?: (
    session: Session,
    signal: "backend:connected" | "backend:disconnected" | "session:closed",
  ) => void;
  canMutateSession?: (sessionId: string, operation: string) => boolean;
  onMutationRejected?: (sessionId: string, operation: string) => void;

  // Orchestration dependencies
  gitTracker: GitInfoTracker;
  gitResolver: GitInfoResolver | null;
  emitEvent: (type: string, payload: unknown) => void;
  capabilitiesPolicy: CapabilitiesPolicy;
}

export class SessionRuntime {
  private lifecycle: LifecycleState = "awaiting_backend";

  constructor(
    private session: Session, // readonly removed — we reassign via spread
    private readonly deps: SessionRuntimeDeps,
  ) {
    this.hydrateSlashRegistryFromState();
  }

  private ensureMutationAllowed(operation: string): boolean {
    if (!this.deps.canMutateSession) return true;
    const allowed = this.deps.canMutateSession(this.session.id, operation);
    if (!allowed) {
      this.deps.onMutationRejected?.(this.session.id, operation);
    }
    return allowed;
  }

  getLifecycleState(): LifecycleState {
    return this.lifecycle;
  }

  getSessionSnapshot(): SessionSnapshot {
    return {
      id: this.session.id,
      state: this.session.data.state,
      lifecycle: this.lifecycle,
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
    if (!this.ensureMutationAllowed("setAdapterName")) return;
    this.session = {
      ...this.session,
      data: {
        ...this.session.data,
        adapterName: name,
        state: { ...this.session.data.state, adapterName: name },
      },
    };
    this.deps.persistSession(this.session);
  }

  getLastStatus(): SessionData["lastStatus"] {
    return this.session.data.lastStatus;
  }

  getState(): SessionData["state"] {
    return this.session.data.state;
  }

  setLastStatus(status: SessionData["lastStatus"]): void {
    if (!this.ensureMutationAllowed("setLastStatus")) return;
    this.session = { ...this.session, data: { ...this.session.data, lastStatus: status } };
  }

  setState(state: SessionData["state"]): void {
    if (!this.ensureMutationAllowed("setState")) return;
    this.session = { ...this.session, data: { ...this.session.data, state } };
  }

  setBackendSessionId(sessionId: string | undefined): void {
    if (!this.ensureMutationAllowed("setBackendSessionId")) return;
    this.session = { ...this.session, data: { ...this.session.data, backendSessionId: sessionId } };
  }

  getMessageHistory(): SessionData["messageHistory"] {
    return this.session.data.messageHistory;
  }

  setMessageHistory(history: SessionData["messageHistory"]): void {
    if (!this.ensureMutationAllowed("setMessageHistory")) return;
    this.session = { ...this.session, data: { ...this.session.data, messageHistory: history } };
  }

  getQueuedMessage(): SessionData["queuedMessage"] {
    return this.session.data.queuedMessage;
  }

  setQueuedMessage(queued: SessionData["queuedMessage"]): void {
    if (!this.ensureMutationAllowed("setQueuedMessage")) return;
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
    if (!this.ensureMutationAllowed("setPendingInitialize")) return;
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
    if (!this.ensureMutationAllowed("registerCLICommands")) return;
    this.session.registry.registerFromCLI?.(commands);
  }

  registerSlashCommandNames(commands: string[]): void {
    if (!this.ensureMutationAllowed("registerSlashCommandNames")) return;
    if (commands.length === 0) return;
    this.registerCLICommands(commands.map((name) => ({ name, description: "" })));
  }

  registerSkillCommands(skills: string[]): void {
    if (!this.ensureMutationAllowed("registerSkillCommands")) return;
    if (skills.length === 0) return;
    this.session.registry.registerSkills?.(skills);
  }

  clearDynamicSlashRegistry(): void {
    if (!this.ensureMutationAllowed("clearDynamicSlashRegistry")) return;
    this.session.registry.clearDynamic?.();
  }

  seedSessionState(params: { cwd?: string; model?: string }): void {
    if (!this.ensureMutationAllowed("seedSessionState")) return;
    const patch: Partial<SessionData["state"]> = {};
    if (params.cwd) patch.cwd = params.cwd;
    if (params.model) patch.model = params.model;
    if (Object.keys(patch).length > 0) {
      this.session = {
        ...this.session,
        data: { ...this.session.data, state: { ...this.session.data.state, ...patch } },
      };
    }
    this.deps.onSessionSeeded?.(this.session);
  }

  allocateAnonymousIdentityIndex(): number {
    if (!this.ensureMutationAllowed("allocateAnonymousIdentityIndex")) {
      return this.session.anonymousCounter;
    }
    this.session.anonymousCounter += 1;
    return this.session.anonymousCounter;
  }

  addConsumer(ws: WebSocketLike, identity: ConsumerIdentity): void {
    if (!this.ensureMutationAllowed("addConsumer")) return;
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
    if (!this.ensureMutationAllowed("attachBackendConnection")) return;
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
    if (!this.ensureMutationAllowed("resetBackendConnectionState")) return;
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
    if (!this.ensureMutationAllowed("drainPendingMessages")) return [];
    const pending = Array.from(this.session.data.pendingMessages);
    this.session = { ...this.session, data: { ...this.session.data, pendingMessages: [] } };
    return pending;
  }

  drainPendingPermissionIds(): string[] {
    if (!this.ensureMutationAllowed("drainPendingPermissionIds")) return [];
    const ids = Array.from(this.session.data.pendingPermissions.keys());
    this.session = {
      ...this.session,
      data: { ...this.session.data, pendingPermissions: new Map() },
    };
    return ids;
  }

  storePendingPermission(requestId: string, request: PermissionRequest): void {
    if (!this.ensureMutationAllowed("storePendingPermission")) return;
    const updated = new Map(this.session.data.pendingPermissions);
    updated.set(requestId, request);
    this.session = { ...this.session, data: { ...this.session.data, pendingPermissions: updated } };
  }

  enqueuePendingPassthrough(entry: Session["pendingPassthroughs"][number]): void {
    if (!this.ensureMutationAllowed("enqueuePendingPassthrough")) return;
    this.session.pendingPassthroughs.push(entry);
  }

  peekPendingPassthrough(): Session["pendingPassthroughs"][number] | undefined {
    return this.session.pendingPassthroughs[0];
  }

  shiftPendingPassthrough(): Session["pendingPassthroughs"][number] | undefined {
    if (!this.ensureMutationAllowed("shiftPendingPassthrough")) return undefined;
    return this.session.pendingPassthroughs.shift();
  }

  checkRateLimit(ws: WebSocketLike, createLimiter: () => RateLimiter | undefined): boolean {
    if (!this.ensureMutationAllowed("checkRateLimit")) return false;
    let limiter = this.session.consumerRateLimiters.get(ws);
    if (!limiter) {
      limiter = createLimiter();
      if (!limiter) return true;
      this.session.consumerRateLimiters.set(ws, limiter);
    }
    return limiter.tryConsume();
  }

  transitionLifecycle(next: LifecycleState, reason: string): boolean {
    if (!this.ensureMutationAllowed("transitionLifecycle")) return false;
    const current = this.lifecycle;
    if (current === next) return true;
    if (!isLifecycleTransitionAllowed(current, next)) {
      this.deps.onInvalidLifecycleTransition?.({
        sessionId: this.session.id,
        from: current,
        to: next,
        reason,
      });
      return false;
    }
    this.lifecycle = next;
    return true;
  }

  handleInboundCommand(msg: InboundCommand, ws: WebSocketLike): void {
    if (!this.ensureMutationAllowed("handleInboundCommand")) return;
    this.touchActivity();
    this.deps.onInboundObserved?.(this.session, msg);
    switch (msg.type) {
      case "user_message":
        // Preserve legacy optimistic running behavior for queue decisions.
        {
          const previousStatus = this.session.data.lastStatus;
          this.session = { ...this.session, data: { ...this.session.data, lastStatus: "running" } };
          const accepted = this.sendUserMessage(msg.content, {
            sessionIdOverride: msg.session_id,
            images: msg.images,
          });
          if (!accepted) {
            this.session = {
              ...this.session,
              data: { ...this.session.data, lastStatus: previousStatus },
            };
            this.deps.broadcaster.sendTo(ws, {
              type: "error",
              message: "Session is closing or closed and cannot accept new messages.",
            });
          }
        }
        break;
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
    this.deps.onInboundHandled?.(this.session, msg);
  }

  sendUserMessage(content: string, options?: RuntimeSendUserMessageOptions): boolean {
    if (!this.ensureMutationAllowed("sendUserMessage")) return false;
    const unified = this.deps.tracedNormalizeInbound(
      this.session,
      {
        type: "user_message",
        content,
        session_id: options?.sessionIdOverride || this.session.data.backendSessionId || "",
        images: options?.images,
      },
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

    const userMsg: ConsumerMessage = {
      type: "user_message",
      content,
      timestamp: this.deps.now(),
    };
    this.session = {
      ...this.session,
      data: {
        ...this.session.data,
        messageHistory: [...this.session.data.messageHistory, userMsg],
      },
    };
    this.trimMessageHistory();
    this.deps.broadcaster.broadcast(this.session, userMsg);

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
    this.deps.persistSession(this.session);
    return true;
  }

  private trimMessageHistory(): void {
    const maxLength = this.deps.maxMessageHistoryLength;
    const history = this.session.data.messageHistory;
    if (history.length > maxLength) {
      this.session = {
        ...this.session,
        data: { ...this.session.data, messageHistory: history.slice(-maxLength) },
      };
    }
  }

  sendPermissionResponse(
    requestId: string,
    behavior: "allow" | "deny",
    options?: RuntimeSendPermissionOptions,
  ): void {
    if (!this.ensureMutationAllowed("sendPermissionResponse")) return;
    const pending = this.session.data.pendingPermissions.get(requestId);
    if (!pending) {
      this.deps.warnUnknownPermission(this.session.id, requestId);
      return;
    }
    const updatedPerms = new Map(this.session.data.pendingPermissions);
    updatedPerms.delete(requestId);
    this.session = {
      ...this.session,
      data: { ...this.session.data, pendingPermissions: updatedPerms },
    };
    this.deps.emitPermissionResolved(this.session.id, requestId, behavior);

    if (!this.session.backendSession) return;
    const unified = this.deps.tracedNormalizeInbound(this.session, {
      type: "permission_response",
      request_id: requestId,
      behavior,
      updated_input: options?.updatedInput,
      updated_permissions: options?.updatedPermissions as
        | import("../../types/cli-messages.js").PermissionUpdate[]
        | undefined,
      message: options?.message,
    });
    if (unified) {
      this.session.backendSession.send(unified);
    }
  }

  sendInterrupt(): void {
    this.sendControlRequest({ type: "interrupt" });
  }

  sendSetModel(model: string): void {
    if (!this.session.backendSession) return;
    this.sendControlRequest({ type: "set_model", model });
    // Optimistically update session state — the backend never sends a
    // configuration_change back, so we must reflect the change ourselves.
    this.session = {
      ...this.session,
      data: { ...this.session.data, state: { ...this.session.data.state, model } },
    };
    this.deps.broadcaster.broadcast(this.session, {
      type: "session_update",
      session: { model },
    });
  }

  sendSetPermissionMode(mode: string): void {
    this.sendControlRequest({ type: "set_permission_mode", mode });
  }

  handlePolicyCommand(command: PolicyCommand): void {
    if (!this.ensureMutationAllowed("handlePolicyCommand")) return;
    switch (command.type) {
      case "reconnect_timeout":
        this.transitionLifecycle("degraded", "policy:reconnect_timeout");
        break;
      case "idle_reap":
        this.transitionLifecycle("closing", "policy:idle_reap");
        break;
      case "capabilities_timeout":
        // Capabilities timeout is advisory; no direct state mutation yet.
        break;
    }
  }

  async executeSlashCommand(
    command: string,
  ): Promise<{ content: string; source: "emulated" } | null> {
    if (!this.ensureMutationAllowed("executeSlashCommand")) return null;
    return this.deps.slashService.executeProgrammatic(this.session, command);
  }

  sendToBackend(message: UnifiedMessage): void {
    if (!this.ensureMutationAllowed("sendToBackend")) return;
    this.deps.sendToBackend(this.session, message);
  }

  private sendControlRequest(msg: InboundCommand): void {
    if (!this.ensureMutationAllowed("sendControlRequest")) return;
    if (!this.session.backendSession) return;
    const unified = this.deps.tracedNormalizeInbound(this.session, msg);
    if (unified) {
      this.session.backendSession.send(unified);
    }
  }

  handleBackendMessage(msg: UnifiedMessage): void {
    if (!this.ensureMutationAllowed("handleBackendMessage")) return;
    this.touchActivity();
    this.deps.onBackendMessageObserved?.(this.session, msg);

    const prevData = this.session.data;
    let [nextData, effects] = reduceSessionData(
      this.session.data,
      msg,
      this.session.teamCorrelationBuffer,
    );

    // Apply history limits (centralized)
    if (nextData.messageHistory.length > this.deps.maxMessageHistoryLength) {
      nextData = {
        ...nextData,
        messageHistory: nextData.messageHistory.slice(-this.deps.maxMessageHistoryLength),
      };
    }

    if (nextData !== this.session.data) {
      this.session = { ...this.session, data: nextData };
      this.deps.persistSession(this.session);
    }

    // Execute reducer effects (T4 broadcasts + event emissions + queue flush)
    executeEffects(effects, this.session, {
      broadcaster: this.deps.broadcaster,
      emitEvent: this.deps.emitEvent,
      queueHandler: this.deps.queueHandler,
    });

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
    this.deps.onBackendMessageHandled?.(this.session, msg);
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
      this.deps.persistSession(this.session);
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

  handleSignal(signal: "backend:connected" | "backend:disconnected" | "session:closed"): void {
    if (!this.ensureMutationAllowed("handleSignal")) return;
    if (signal === "backend:connected") {
      this.transitionLifecycle("active", "signal:backend:connected");
    } else if (signal === "backend:disconnected") {
      this.transitionLifecycle("degraded", "signal:backend:disconnected");
    } else if (signal === "session:closed") {
      this.transitionLifecycle("closed", "signal:session:closed");
    }
    this.deps.onSignal?.(this.session, signal);
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
    this.session.lastActivity = this.deps.now();
  }

  private hydrateSlashRegistryFromState(): void {
    this.clearDynamicSlashRegistry();
    this.registerSlashCommandNames(this.session.data.state.slash_commands ?? []);
    this.registerSkillCommands(this.session.data.state.skills ?? []);
  }
}
