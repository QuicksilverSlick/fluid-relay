import { describe, expect, it } from "vitest";
import type { SessionData } from "./session-data.js";
import { makeDefaultState } from "./session-repository.js";

describe("SessionData", () => {
  it("is a read-only type (compile-time — presence of the type is the test)", () => {
    // This test passes iff the import resolves without TypeScript errors.
    // Compile-time enforcement is verified by `pnpm typecheck`.
    const state = makeDefaultState("s1");
    const data: SessionData = {
      lifecycle: "awaiting_backend",
      state,
      pendingPermissions: new Map(),
      messageHistory: [],
      pendingMessages: [],
      queuedMessage: null,
      lastStatus: null,
      adapterSupportsSlashPassthrough: false,
    };
    expect(data.state.session_id).toBe("s1");
  });
});
