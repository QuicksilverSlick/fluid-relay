import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import {
  createBridgeWithAdapter,
  type MockBackendAdapter,
  makeAssistantUnifiedMsg,
  makeSessionInitMsg,
  tick,
} from "../testing/adapter-test-helpers.js";
import {
  authContext,
  createTestSocket as createMockSocket,
} from "../testing/cli-message-factories.js";
import type { SessionBridge as SessionBridgeType } from "./session-bridge.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionBridge — Event emission", () => {
  let bridge: SessionBridgeType;
  let adapter: MockBackendAdapter;

  beforeEach(() => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    adapter = created.adapter;
  });

  it("emits backend connected/disconnected lifecycle events", async () => {
    const connected = vi.fn();
    const disconnected = vi.fn();
    bridge.on("backend:connected", connected);
    bridge.on("backend:disconnected", disconnected);

    await bridge.connectBackend("sess-1");
    expect(connected).toHaveBeenCalledWith({ sessionId: "sess-1" });

    await bridge.disconnectBackend("sess-1");
    expect(disconnected).toHaveBeenCalledWith({
      sessionId: "sess-1",
      code: 1000,
      reason: "normal",
    });
  });

  it("emits message:inbound for every consumer message", async () => {
    await bridge.connectBackend("sess-1");
    const ws = createMockSocket();
    bridge.handleConsumerOpen(ws, authContext("sess-1"));

    const handler = vi.fn();
    bridge.on("message:inbound", handler);

    bridge.handleConsumerMessage(ws, "sess-1", JSON.stringify({ type: "interrupt" }));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        message: { type: "interrupt" },
      }),
    );
  });

  it("emits error when sendToBackend fails", async () => {
    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;

    // Make the backend session's send throw
    backendSession.send = () => {
      throw new Error("Backend write failed");
    };

    const handler = vi.fn();
    bridge.on("error", handler);

    // Use sendToBackend which routes through BackendLifecycleManager (try/catch + error emit)
    bridge.sendToBackend("sess-1", makeAssistantUnifiedMsg());

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "sendToBackend",
        error: expect.any(Error),
        sessionId: "sess-1",
      }),
    );
  });
});

// ─── Behavior lock: connectBackend event ordering ─────────────────────────────

describe("SessionBridge — connectBackend event ordering (behavior lock)", () => {
  let bridge: SessionBridgeType;
  let adapter: MockBackendAdapter;

  beforeEach(() => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    adapter = created.adapter;
  });

  it("backend:connected is emitted before backend:session_id", async () => {
    const events: string[] = [];

    bridge.on("backend:connected", () => events.push("backend:connected"));
    bridge.on("backend:session_id", () => events.push("backend:session_id"));

    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;

    // At this point only backend:connected should have fired
    expect(events).toEqual(["backend:connected"]);

    // backend:session_id arrives later via system_init from the CLI
    backendSession.pushMessage(makeSessionInitMsg({ session_id: "cli-xyz" }));
    await tick();

    expect(events).toEqual(["backend:connected", "backend:session_id"]);
  });
});
