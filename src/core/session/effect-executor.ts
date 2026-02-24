/**
 * Effect Executor
 *
 * Executes the `Effect[]` returned by `reduceSessionData`.
 * Bridges pure reducer output to side-effectful runtime services.
 *
 * @module SessionControl
 */

import type { SessionState } from "../../types/session-state.js";
import type { ConsumerBroadcaster } from "../consumer/consumer-broadcaster.js";
import type { Effect } from "./effect-types.js";
import type { Session } from "./session-repository.js";

export interface EffectExecutorDeps {
  broadcaster: Pick<ConsumerBroadcaster, "broadcast" | "broadcastToParticipants">;
  emitEvent: (type: string, payload: unknown) => void;
  queueHandler: { autoSendQueuedMessage: (session: Session) => void };
}

/**
 * Execute a list of effects against live session services.
 * Effects are executed in order; all are synchronous.
 */
export function executeEffects(
  effects: Effect[],
  session: Session,
  deps: EffectExecutorDeps,
): void {
  for (const effect of effects) {
    switch (effect.type) {
      case "BROADCAST":
        deps.broadcaster.broadcast(session, effect.message);
        break;

      case "BROADCAST_TO_PARTICIPANTS":
        deps.broadcaster.broadcastToParticipants(session, effect.message);
        break;

      case "BROADCAST_SESSION_UPDATE":
        deps.broadcaster.broadcast(session, {
          type: "session_update",
          session: effect.patch as Partial<SessionState>,
        });
        break;

      case "EMIT_EVENT": {
        // Inject sessionId so event listeners always receive it
        const payload =
          typeof effect.payload === "object" && effect.payload !== null
            ? { sessionId: session.id, ...(effect.payload as object) }
            : effect.payload;
        deps.emitEvent(effect.eventType, payload);
        break;
      }

      case "AUTO_SEND_QUEUED":
        deps.queueHandler.autoSendQueuedMessage(session);
        break;
    }
  }
}
