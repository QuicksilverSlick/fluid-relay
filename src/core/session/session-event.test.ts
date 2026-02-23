import { describe, expect, it } from "vitest";
import type { SessionEvent } from "./session-event.js";

describe("SessionEvent types", () => {
  it("can construct a BACKEND_MESSAGE event", () => {
    const event: SessionEvent = {
      type: "BACKEND_MESSAGE",
      message: { type: "assistant", role: "assistant", content: [], metadata: {} } as any,
    };
    expect(event.type).toBe("BACKEND_MESSAGE");
  });

  it("can construct an INBOUND_COMMAND event", () => {
    const event: SessionEvent = {
      type: "INBOUND_COMMAND",
      command: { type: "user_message", content: "hello" } as any,
      ws: {} as any,
    };
    expect(event.type).toBe("INBOUND_COMMAND");
  });

  it("can construct a POLICY_COMMAND event", () => {
    const event: SessionEvent = {
      type: "POLICY_COMMAND",
      command: { type: "capabilities_timeout" },
    };
    expect(event.type).toBe("POLICY_COMMAND");
  });

  it("can construct a LIFECYCLE_SIGNAL event", () => {
    const event: SessionEvent = {
      type: "LIFECYCLE_SIGNAL",
      signal: "backend:connected",
    };
    expect(event.type).toBe("LIFECYCLE_SIGNAL");
  });
});
