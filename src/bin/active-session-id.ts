import type { SessionInfo } from "../types/session-state.js";

/**
 * Pick the newest session ID by createdAt. Returns empty string when no sessions exist.
 */
export function pickMostRecentSessionId(sessions: readonly SessionInfo[]): string {
  let newest: SessionInfo | null = null;
  for (const session of sessions) {
    if (!newest || session.createdAt > newest.createdAt) {
      newest = session;
    }
  }
  return newest?.sessionId ?? "";
}

/**
 * Keep the current active ID when still valid; otherwise fall back to newest session.
 */
export function reconcileActiveSessionId(
  currentActiveSessionId: string,
  sessions: readonly SessionInfo[],
): string {
  if (
    currentActiveSessionId &&
    sessions.some((session) => session.sessionId === currentActiveSessionId)
  ) {
    return currentActiveSessionId;
  }
  return pickMostRecentSessionId(sessions);
}
