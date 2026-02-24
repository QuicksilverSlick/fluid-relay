/**
 * Effect Mapper — pure event → Effect[] mapping for non-backend-message events.
 *
 * `session-state-reducer.ts` already handles Effect generation for
 * BACKEND_MESSAGE events (inline in `buildEffects`). This module covers
 * INBOUND_COMMAND only:
 *
 *   INBOUND_COMMAND  → error broadcasts, session_update patches
 *
 * SYSTEM_SIGNAL effects are produced inline in session-reducer.ts
 * (inside `reduceSystemSignal`) and do not go through this mapper.
 *
 * All functions are pure — no I/O, no closure over external state.
 * The caller (session-reducer.ts / SessionRuntime) executes the returned
 * effects via EffectExecutor after applying the new state.
 *
 * @module SessionControl
 */

import type { ConsumerMessage } from "../../types/consumer-messages.js";
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
 * This covers only commands that fall through reduceInboundCommand's default
 * case — commands handled explicitly (user_message, set_model) never reach
 * this mapper.
 *
 * Effects requiring handles (backend sends, slash execution) are executed
 * directly by SessionRuntime and do not go through this mapper.
 */
export function mapInboundCommandEffects(commandType: string, _ctx: EffectMapperContext): Effect[] {
  switch (commandType) {
    case "set_adapter":
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
