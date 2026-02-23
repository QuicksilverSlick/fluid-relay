/**
 * SessionRepository — in-memory session store with persistence support.
 *
 * Owns the Session type definition and the in-memory session map. Provides
 * CRUD operations, snapshot extraction for the HTTP API, and disk
 * persistence/restore for server restarts. Each Session holds all per-session
 * runtime state: consumer sockets, backend connection, message history,
 * pending permissions, and slash command registry.
 *
 * @module SessionControl
 */

import type { ConsumerIdentity, ConsumerRole } from "../../interfaces/auth.js";
import type { SessionStorage } from "../../interfaces/storage.js";
import type { PermissionRequest } from "../../types/cli-messages.js";
import type { ConsumerMessage } from "../../types/consumer-messages.js";
import type { SessionSnapshot, SessionState } from "../../types/session-state.js";
import type { AdapterSlashExecutor } from "../interfaces/backend-adapter.js";
import type { SlashCommandRegistry } from "../slash/slash-command-registry.js";
import type { TeamToolCorrelationBuffer } from "../team/team-tool-correlation.js";
import type { UnifiedMessage } from "../types/unified-message.js";
import type { SessionData, SessionHandles } from "./session-data.js";

export type { AdapterSlashExecutor };

export interface QueuedMessage {
  consumerId: string;
  displayName: string;
  content: string;
  images?: { media_type: string; data: string }[];
  queuedAt: number;
}

export type { SessionHandles } from "./session-data.js";

export interface Session extends SessionHandles {
  // ── Immutable lookup key ────────────────────────────────────────────────
  readonly id: string;

  // ── Serializable state (sole ownership: SessionRuntime) ─────────────────
  readonly data: SessionData;
}

export function makeDefaultState(sessionId: string): SessionState {
  return {
    session_id: sessionId,
    model: "",
    cwd: "",
    tools: [],
    permissionMode: "default",
    claude_code_version: "",
    mcp_servers: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    repo_root: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
  };
}

/** Extract a plain presence entry from a ConsumerIdentity (defensive copy). */
export function toPresenceEntry(id: ConsumerIdentity): {
  userId: string;
  displayName: string;
  role: ConsumerRole;
} {
  return { userId: id.userId, displayName: id.displayName, role: id.role };
}

export interface SessionStoreFactories {
  createCorrelationBuffer: () => TeamToolCorrelationBuffer;
  createRegistry: () => SlashCommandRegistry;
}

/**
 * SessionRepository owns the in-memory session map and persistence snapshots.
 */
export class SessionRepository {
  private sessions = new Map<string, Session>();
  private storage: SessionStorage | null;
  private factories: SessionStoreFactories;

  constructor(storage: SessionStorage | null, factories: SessionStoreFactories) {
    this.storage = storage;
    this.factories = factories;
  }

  getStorage(): SessionStorage | null {
    return this.storage;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getOrCreate(id: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      session = this.createSession(id, makeDefaultState(id));
      this.sessions.set(id, session);
    }
    return session;
  }

  getSnapshot(id: string): SessionSnapshot | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    return {
      id: session.id,
      state: session.data.state,
      cliConnected: session.backendSession !== null,
      consumerCount: session.consumerSockets.size,
      consumers: Array.from(session.consumerSockets.values()).map(toPresenceEntry),
      pendingPermissions: Array.from(session.data.pendingPermissions.values()),
      messageHistoryLength: session.data.messageHistory.length,
      lastActivity: session.lastActivity,
      lastStatus: session.data.lastStatus,
    };
  }

  getAllStates(): SessionState[] {
    return Array.from(this.sessions.values()).map((s) => s.data.state);
  }

  isCliConnected(id: string): boolean {
    const session = this.sessions.get(id);
    return !!session?.backendSession;
  }

  /** Remove a session from the map and storage (does NOT close sockets). */
  remove(id: string): void {
    this.sessions.delete(id);
    this.storage?.remove(id);
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  keys(): IterableIterator<string> {
    return this.sessions.keys();
  }

  /** Create a new disconnected session with the given state. */
  createSession(
    id: string,
    state: SessionState,
    overrides?: {
      pendingPermissions?: Map<string, PermissionRequest>;
      messageHistory?: ConsumerMessage[];
      pendingMessages?: UnifiedMessage[];
      queuedMessage?: QueuedMessage | null;
    },
  ): Session {
    return {
      id,
      data: {
        lifecycle: "awaiting_backend",
        state,
        pendingPermissions: overrides?.pendingPermissions ?? new Map(),
        messageHistory: overrides?.messageHistory ?? [],
        pendingMessages: overrides?.pendingMessages ?? [],
        queuedMessage: overrides?.queuedMessage ?? null,
        lastStatus: null,
        adapterName: state.adapterName,
        adapterSupportsSlashPassthrough: false,
      },
      backendSession: null,
      backendAbort: null,
      consumerSockets: new Map(),
      consumerRateLimiters: new Map(),
      anonymousCounter: 0,
      lastActivity: Date.now(),
      pendingInitialize: null,
      teamCorrelationBuffer: this.factories.createCorrelationBuffer(),
      registry: this.factories.createRegistry(),
      pendingPassthroughs: [],
      adapterSlashExecutor: null,
    };
  }

  /** Persist a session snapshot to disk. */
  persist(session: Session): void {
    this.sessions.set(session.id, session);
    if (!this.storage) return;
    this.storage.save({
      id: session.id,
      state: session.data.state,
      messageHistory: Array.from(session.data.messageHistory),
      pendingMessages: Array.from(session.data.pendingMessages),
      pendingPermissions: Array.from(session.data.pendingPermissions.entries()),
      queuedMessage: session.data.queuedMessage,
      adapterName: session.data.adapterName,
    });
  }

  /** Persist a session snapshot to disk synchronously (critical state writes). */
  persistSync(session: Session): void {
    this.sessions.set(session.id, session);
    if (!this.storage) return;
    this.storage.saveSync({
      id: session.id,
      state: session.data.state,
      messageHistory: Array.from(session.data.messageHistory),
      pendingMessages: Array.from(session.data.pendingMessages),
      pendingPermissions: Array.from(session.data.pendingPermissions.entries()),
      queuedMessage: session.data.queuedMessage,
      adapterName: session.data.adapterName,
    });
  }

  /** Restore sessions from disk (call once at startup). Returns count restored. */
  restoreAll(): number {
    if (!this.storage) return 0;
    const persisted = this.storage.loadAll();
    let count = 0;
    for (const p of persisted) {
      if (this.sessions.has(p.id)) continue; // don't overwrite live sessions

      const restoredState = p.adapterName ? { ...p.state, adapterName: p.adapterName } : p.state;
      const session = this.createSession(p.id, restoredState, {
        pendingPermissions: new Map(p.pendingPermissions || []),
        messageHistory: p.messageHistory || [],
        pendingMessages: (p.pendingMessages || []) as UnifiedMessage[],
        queuedMessage: (p.queuedMessage ?? null) as QueuedMessage | null,
      });

      this.sessions.set(p.id, session);
      count++;
    }
    return count;
  }
}
