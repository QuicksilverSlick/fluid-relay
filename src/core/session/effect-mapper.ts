/**
 * Effect Mapper — pure event → Effect[] mapping for non-backend-message events.
 *
 * `session-state-reducer.ts` already handles Effect generation for
 * BACKEND_MESSAGE events (inline in `buildEffects`). This module covers
 * the remaining two event types:
 *
 *   SYSTEM_SIGNAL    → typically no consumer-visible effects (lifecycle only)
 *   INBOUND_COMMAND  → error broadcasts, session_update patches
 *
 * All functions are pure — no I/O, no closure over external state.
 * The caller (session-reducer.ts / SessionRuntime) executes the returned
 * effects via EffectExecutor after applying the new state.
 *
 * @module SessionControl
 */

import type { ConsumerMessage } from "../../types/consumer-messages.js";
import type { SessionState } from "../../types/session-state.js";
import type { Effect } from "./effect-types.js";
import type { LifecycleState } from "./session-lifecycle.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Context snapshot passed to effect mappers — all readonly, pure data. */
export interface EffectMapperContext {
  readonly sessionId: string;
  readonly lifecycle: LifecycleState;
  readonly currentModel?: string;
}

/**
 * Map an inbound command type to the Effects it produces on the consumer side.
 *
 * This covers only the Effects that can be determined purely from SessionData,
 * without needing live handles (BackendSession, SlashService, etc.).
 *
 * Effects requiring handles (backend sends, slash execution) are executed
 * directly by SessionRuntime and do not go through this mapper.
 */
export function mapInboundCommandEffects(commandType: string, ctx: EffectMapperContext): Effect[] {
  switch (commandType) {
    case "user_message":
      return mapUserMessageEffects(ctx);

    case "set_adapter":
      // Adapter changes on live sessions are not supported — describe the error.
      return [
        {
          type: "BROADCAST",
          message: {
            type: "error",
            message:
              "Adapter cannot be changed on an active session. Create a new session with the desired adapter.",
          } as ConsumerMessage,
        },
      ];

    default:
      return [];
  }
}

/**
 * Map a set_model inbound command to its Effects.
 * (Called after the state mutation, so the new model value is passed in.)
 */
export function mapSetModelEffects(newModel: string): Effect[] {
  return [
    {
      type: "BROADCAST_SESSION_UPDATE",
      patch: { model: newModel } as Partial<SessionState>,
    },
  ];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function mapUserMessageEffects(ctx: EffectMapperContext): Effect[] {
  // If the session is closing or closed when a user_message arrives,
  // broadcast an error. The session state didn't change — just an effect.
  if (ctx.lifecycle === "closing" || ctx.lifecycle === "closed") {
    return [
      {
        type: "BROADCAST",
        message: {
          type: "error",
          message: "Session is closing or closed and cannot accept new messages.",
        } as ConsumerMessage,
      },
    ];
  }

  // Happy path: no effects to describe here — the actual message broadcast
  // is emitted inline by sendUserMessage() after the backend send succeeds,
  // because it needs a live broadcaster.broadcast() call with the constructed
  // ConsumerMessage. As the reducer is hoisted purely, we return [] and let
  // the runtime handle it.
  return [];
}
