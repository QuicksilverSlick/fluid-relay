/**
 * CapabilitiesPolicy — SessionControl initialize handshake manager.
 *
 * Manages the initialize handshake: sending the `initialize` control_request,
 * handling the control_response (success or error), applying capabilities to
 * session state, and cleaning up on timeout or cancellation.
 *
 * Capabilities (commands, models, account info) are discovered at connect time
 * and broadcast to all consumers via `capabilities_ready`.
 *
 * @module SessionControl
 */

import { randomUUID } from "node:crypto";
import type { Logger } from "../../interfaces/logger.js";
import type {
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
} from "../../types/cli-messages.js";
import type { ResolvedConfig } from "../../types/config.js";
import type { SessionData } from "../session/session-data.js";
import type { Session } from "../session/session-repository.js";
import type { SessionRuntime } from "../session/session-runtime.js";
import type { UnifiedMessage } from "../types/unified-message.js";

// ─── CapabilitiesPolicy ─────────────────────────────────────────────────────

export class CapabilitiesPolicy {
  constructor(
    private config: ResolvedConfig,
    private logger: Logger,
    private getRuntime: (session: Session) => SessionRuntime,
  ) {}

  private getState(session: Session): SessionData["state"] {
    return this.getRuntime(session).getState();
  }

  private getPendingInitialize(session: Session): Session["pendingInitialize"] {
    return this.getRuntime(session).getPendingInitialize();
  }

  private setPendingInitialize(
    session: Session,
    pendingInitialize: Session["pendingInitialize"],
  ): void {
    this.getRuntime(session).setPendingInitialize(pendingInitialize);
  }

  sendInitializeRequest(session: Session): void {
    if (this.getPendingInitialize(session)) return; // dedup
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      if (this.getPendingInitialize(session)?.requestId === requestId) {
        this.setPendingInitialize(session, null);
        this.getRuntime(session).process({
          type: "SYSTEM_SIGNAL",
          signal: { kind: "CAPABILITIES_TIMEOUT" },
        });
      }
    }, this.config.initializeTimeoutMs);
    this.setPendingInitialize(session, { requestId, timer });

    const result = this.getRuntime(session).tryInitializeBackend(requestId);
    if (result === "unsupported") {
      // Adapter doesn't support the initialize handshake (e.g. Codex) —
      // capabilities arrive via the init response instead.
      this.logger.info(
        `Skipping initialize for session ${session.id}: adapter does not support initialize`,
      );
      clearTimeout(timer);
      this.setPendingInitialize(session, null);
    } else if (result === "no_backend") {
      // Backend not yet attached — cancel the pending initialize so the timer
      // doesn't fire a spurious CAPABILITIES_TIMEOUT.
      this.logger.warn(
        `sendInitializeRequest called for session ${session.id} before backend connected — cancelling`,
      );
      clearTimeout(timer);
      this.setPendingInitialize(session, null);
    }
  }

  cancelPendingInitialize(session: Session): void {
    const pendingInitialize = this.getPendingInitialize(session);
    if (pendingInitialize) {
      clearTimeout(pendingInitialize.timer);
      this.setPendingInitialize(session, null);
    }
  }

  handleControlResponse(session: Session, msg: UnifiedMessage): void {
    const m = msg.metadata;

    // Match against pending initialize request
    const pendingInitialize = this.getPendingInitialize(session);
    if (!pendingInitialize || pendingInitialize.requestId !== (m.request_id as string)) {
      return;
    }
    clearTimeout(pendingInitialize.timer);
    this.setPendingInitialize(session, null);

    if (m.subtype === "error") {
      this.logger.warn(`Initialize failed: ${m.error}`);
      // Synthesize capabilities from session state (populated by session_init)
      // so consumers still receive capabilities_ready even when the CLI
      // refuses to re-initialize (e.g. "Already initialized").
      const state = this.getState(session);
      if (!state.capabilities && state.slash_commands.length > 0) {
        const commands = state.slash_commands.map((name: string) => ({
          name,
          description: "",
        }));
        this.applyCapabilities(session, commands, [], null);
      }
      return;
    }

    const response = m.response as
      | { commands?: unknown[]; models?: unknown[]; account?: unknown }
      | undefined;
    if (!response) {
      this.logger.warn(
        `Initialize control_response for session ${session.id} has no response body`,
      );
      return;
    }

    const commands = Array.isArray(response.commands)
      ? (response.commands as InitializeCommand[])
      : [];
    const models = Array.isArray(response.models) ? (response.models as InitializeModel[]) : [];
    const account = (response.account as InitializeAccount | null) ?? null;

    this.applyCapabilities(session, commands, models, account);
  }

  applyCapabilities(
    session: Session,
    commands: InitializeCommand[],
    models: InitializeModel[],
    account: InitializeAccount | null,
  ): void {
    this.getRuntime(session).process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "CAPABILITIES_APPLIED", commands, models, account },
    });
    this.logger.info(
      `Capabilities received for session ${session.id}: ${commands.length} commands, ${models.length} models`,
    );
  }
}
