/**
 * History Reducer — pure message history management.
 *
 * Centralizes all logic for appending, deduplicating, and trimming the
 * session message history. Extracted so the history algorithm can be
 * tested independently of the full session state reducer.
 *
 * All functions are pure — no side effects, no dependencies on runtime
 * services.
 *
 * @module SessionControl
 */

import type { ConsumerMessage } from "../../types/consumer-messages.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a user message to the history, then trim if over the limit.
 * Returns the same reference if nothing changed.
 */
export function appendUserMessage(
  history: readonly ConsumerMessage[],
  msg: Extract<ConsumerMessage, { type: "user_message" }>,
  maxLength: number,
): readonly ConsumerMessage[] {
  const appended = [...history, msg];
  return trimHistory(appended, maxLength);
}

/**
 * Trim history to at most `maxLength` entries, removing oldest first.
 * Returns the same reference if no trimming needed.
 */
export function trimHistory(
  history: readonly ConsumerMessage[],
  maxLength: number,
): readonly ConsumerMessage[] {
  if (history.length <= maxLength) return history;
  return history.slice(-maxLength);
}

/**
 * Upsert an assistant message in history by message ID (dedup strategy):
 * - If an existing entry with the same ID is found and is equivalent → no change.
 * - If found but content changed → replace in-place.
 * - If not found → append.
 *
 * Returns the same reference if nothing changed.
 */
export function upsertAssistantMessage(
  history: readonly ConsumerMessage[],
  msg: Extract<ConsumerMessage, { type: "assistant" }>,
): readonly ConsumerMessage[] {
  // Scan backwards (most recent first) for an existing entry with this ID
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item.type !== "assistant") continue;
    const existing = item as Extract<ConsumerMessage, { type: "assistant" }>;
    if (existing.message.id !== msg.message.id) continue;

    // Found — check if it needs updating
    if (assistantMessagesEquivalent(existing, msg)) {
      return history; // No change — return same reference
    }
    const next = [...history];
    next[i] = msg;
    return next;
  }

  // Not found — append
  return [...history, msg];
}

/**
 * Upsert a tool_use_summary in history by tool_use_id (dedup strategy).
 * Returns the same reference if nothing changed.
 */
export function upsertToolUseSummary(
  history: readonly ConsumerMessage[],
  msg: Extract<ConsumerMessage, { type: "tool_use_summary" }>,
): readonly ConsumerMessage[] {
  const toolUseId = msg.tool_use_id ?? msg.tool_use_ids[0];
  if (toolUseId) {
    for (let i = history.length - 1; i >= 0; i--) {
      const item = history[i];
      if (item.type !== "tool_use_summary") continue;
      const itemId = item.tool_use_id ?? item.tool_use_ids[0];
      if (itemId !== toolUseId) continue;

      const existing = item as Extract<ConsumerMessage, { type: "tool_use_summary" }>;
      if (toolSummariesEquivalent(existing, msg)) {
        return history;
      }
      const next = [...history];
      next[i] = msg;
      return next;
    }
  }

  return [...history, msg];
}

// ---------------------------------------------------------------------------
// Equivalence helpers (pure)
// ---------------------------------------------------------------------------

function assistantMessagesEquivalent(
  a: Extract<ConsumerMessage, { type: "assistant" }>,
  b: Extract<ConsumerMessage, { type: "assistant" }>,
): boolean {
  if (a.parent_tool_use_id !== b.parent_tool_use_id) return false;
  if (a.message.id !== b.message.id) return false;
  if (a.message.model !== b.message.model) return false;
  if (a.message.stop_reason !== b.message.stop_reason) return false;
  return JSON.stringify(a.message.content) === JSON.stringify(b.message.content);
}

function toolSummariesEquivalent(
  a: Extract<ConsumerMessage, { type: "tool_use_summary" }>,
  b: Extract<ConsumerMessage, { type: "tool_use_summary" }>,
): boolean {
  return (
    a.summary === b.summary &&
    a.status === b.status &&
    a.is_error === b.is_error &&
    JSON.stringify(a.tool_use_ids) === JSON.stringify(b.tool_use_ids) &&
    JSON.stringify(a.output) === JSON.stringify(b.output) &&
    JSON.stringify(a.error) === JSON.stringify(b.error)
  );
}
