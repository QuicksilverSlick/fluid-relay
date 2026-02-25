/**
 * MessageQueueHandler — extracted from SessionBridge.
 *
 * Manages the single-slot message queue: storing a queued message when the
 * session is busy, updating/cancelling it, and auto-sending when the session
 * becomes idle.
 */

import type { ConsumerIdentity } from "../../interfaces/auth.js";
import type { WebSocketLike } from "../../interfaces/transport.js";
import type { SessionData } from "../session/session-data.js";
import type { QueuedMessage, Session } from "./session-repository.js";
import type { SessionRuntime } from "./session-runtime.js";

// ─── Types ────────────────────────────────────────────────────────────────────

type ImageAttachment = { media_type: string; data: string };

type SendUserMessage = (
  sessionId: string,
  content: string,
  options?: { images?: ImageAttachment[] },
) => void;

// ─── MessageQueueHandler ──────────────────────────────────────────────────────

export class MessageQueueHandler {
  constructor(
    private sendUserMessage: SendUserMessage,
    private getRuntime: (session: Session) => SessionRuntime,
  ) {}

  private getLastStatus(session: Session): SessionData["lastStatus"] {
    return this.getRuntime(session).getLastStatus();
  }

  private setLastStatus(session: Session, status: SessionData["lastStatus"]): void {
    this.getRuntime(session).process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "LAST_STATUS_UPDATED", status },
    });
  }

  private getQueuedMessage(session: Session): QueuedMessage | null {
    return this.getRuntime(session).getQueuedMessage();
  }

  private getConsumerIdentity(session: Session, ws: WebSocketLike): ConsumerIdentity | undefined {
    return this.getRuntime(session).getConsumerIdentity(ws);
  }

  handleQueueMessage(
    session: Session,
    msg: {
      type: "queue_message";
      content: string;
      images?: ImageAttachment[];
    },
    ws: WebSocketLike,
  ): void {
    // Enforce single-slot semantics before any fast-path dispatch. This keeps
    // restored queue state authoritative after restart.
    if (this.getQueuedMessage(session)) {
      this.getRuntime(session).process({
        type: "SYSTEM_SIGNAL",
        signal: {
          kind: "QUEUE_ERROR",
          ws,
          message: "A message is already queued for this session",
        },
      });
      return;
    }

    // If session is idle or its status is unknown, send immediately as user_message.
    // Otherwise (e.g. "running", "compacting"), proceed to queue it.
    const status = this.getLastStatus(session);
    if (!status || status === "idle") {
      // Optimistically mark running — the CLI will process this message, but
      // message_start won't arrive until the API starts streaming (1-5s gap).
      // Without this, queue_message arriving in that gap sees lastStatus as
      // null/idle and bypasses the queue.
      this.setLastStatus(session, "running");
      this.sendUserMessage(session.id, msg.content, { images: msg.images });
      return;
    }

    const identity = this.getConsumerIdentity(session, ws);
    if (!identity) {
      this.getRuntime(session).process({
        type: "SYSTEM_SIGNAL",
        signal: {
          kind: "QUEUE_ERROR",
          ws,
          message: "Cannot queue message: consumer identity not found. Please reconnect.",
        },
      });
      return;
    }

    const queued: QueuedMessage = {
      consumerId: identity.userId,
      displayName: identity.displayName,
      content: msg.content,
      images: msg.images,
      queuedAt: Date.now(),
    };
    this.getRuntime(session).process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "MESSAGE_QUEUED", queued },
    });
  }

  handleUpdateQueuedMessage(
    session: Session,
    msg: {
      type: "update_queued_message";
      content: string;
      images?: ImageAttachment[];
    },
    ws: WebSocketLike,
  ): void {
    const existing = this.getQueuedMessage(session);
    if (!existing) return;

    const identity = this.getConsumerIdentity(session, ws);
    if (!identity || identity.userId !== existing.consumerId) {
      this.getRuntime(session).process({
        type: "SYSTEM_SIGNAL",
        signal: {
          kind: "QUEUE_ERROR",
          ws,
          message: "Only the message author can edit a queued message",
        },
      });
      return;
    }

    this.getRuntime(session).process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "QUEUED_MESSAGE_EDITED", content: msg.content, images: msg.images },
    });
  }

  handleCancelQueuedMessage(session: Session, ws: WebSocketLike): void {
    const existing = this.getQueuedMessage(session);
    if (!existing) return;

    const identity = this.getConsumerIdentity(session, ws);
    if (!identity || identity.userId !== existing.consumerId) {
      this.getRuntime(session).process({
        type: "SYSTEM_SIGNAL",
        signal: {
          kind: "QUEUE_ERROR",
          ws,
          message: "Only the message author can cancel a queued message",
        },
      });
      return;
    }

    this.getRuntime(session).process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "QUEUED_MESSAGE_CANCELLED" },
    });
  }

  autoSendQueuedMessage(session: Session): void {
    const queued = this.getQueuedMessage(session);
    if (!queued) return;
    this.getRuntime(session).process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "QUEUED_MESSAGE_SENT" },
    });
    this.sendUserMessage(session.id, queued.content, {
      images: queued.images,
    });
  }
}
