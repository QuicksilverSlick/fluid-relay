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

  it("can construct a SYSTEM_SIGNAL event (BACKEND_CONNECTED)", () => {
    const event: SessionEvent = {
      type: "SYSTEM_SIGNAL",
      signal: { kind: "BACKEND_CONNECTED" },
    };
    expect(event.type).toBe("SYSTEM_SIGNAL");
    if (event.type === "SYSTEM_SIGNAL") {
      expect(event.signal.kind).toBe("BACKEND_CONNECTED");
    }
  });

  it("can construct a SYSTEM_SIGNAL event (IDLE_REAP)", () => {
    const event: SessionEvent = {
      type: "SYSTEM_SIGNAL",
      signal: { kind: "IDLE_REAP" },
    };
    expect(event.type).toBe("SYSTEM_SIGNAL");
  });

  it("can construct a SYSTEM_SIGNAL event (CONSUMER_DISCONNECTED)", () => {
    const event: SessionEvent = {
      type: "SYSTEM_SIGNAL",
      signal: { kind: "CONSUMER_DISCONNECTED", ws: {} as any },
    };
    expect(event.type).toBe("SYSTEM_SIGNAL");
  });
});
