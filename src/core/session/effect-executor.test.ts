import { describe, expect, it, vi } from "vitest";
import { createUnifiedMessage } from "../types/unified-message.js";
import { executeEffects } from "./effect-executor.js";
import type { Session } from "./session-repository.js";

function makeSession(id = "s1"): Session {
  return { id } as unknown as Session;
}

function makeDeps() {
  return {
    broadcaster: {
      broadcast: vi.fn(),
      broadcastToParticipants: vi.fn(),
    },
    emitEvent: vi.fn(),
    queueHandler: { autoSendQueuedMessage: vi.fn() },
    backendConnector: { sendToBackend: vi.fn() },
    store: { persist: vi.fn() },
  };
}

describe("executeEffects", () => {
  it("executes BROADCAST effect", () => {
    const deps = makeDeps();
    const session = makeSession();
    const message = { type: "status_change", status: "idle" } as any;

    executeEffects([{ type: "BROADCAST", message }], session, deps);

    expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(session, message);
  });

  it("executes BROADCAST_TO_PARTICIPANTS effect", () => {
    const deps = makeDeps();
    const session = makeSession();
    const message = { type: "permission_request", request: {} } as any;

    executeEffects([{ type: "BROADCAST_TO_PARTICIPANTS", message }], session, deps);

    expect(deps.broadcaster.broadcastToParticipants).toHaveBeenCalledWith(session, message);
  });

  it("executes BROADCAST_SESSION_UPDATE as session_update broadcast", () => {
    const deps = makeDeps();
    const session = makeSession();

    executeEffects(
      [{ type: "BROADCAST_SESSION_UPDATE", patch: { model: "gpt-4" } }],
      session,
      deps,
    );

    expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(session, {
      type: "session_update",
      session: { model: "gpt-4" },
    });
  });

  it("executes EMIT_EVENT and injects sessionId into object payload", () => {
    const deps = makeDeps();
    const session = makeSession("sess-abc");

    executeEffects(
      [
        {
          type: "EMIT_EVENT",
          eventType: "session:first_turn_completed",
          payload: { firstUserMessage: "hi" },
        },
      ],
      session,
      deps,
    );

    expect(deps.emitEvent).toHaveBeenCalledWith("session:first_turn_completed", {
      sessionId: "sess-abc",
      firstUserMessage: "hi",
    });
  });

  it("executes EMIT_EVENT with primitive payload without wrapping", () => {
    const deps = makeDeps();
    const session = makeSession("sess-abc");

    executeEffects([{ type: "EMIT_EVENT", eventType: "some:event", payload: 42 }], session, deps);

    expect(deps.emitEvent).toHaveBeenCalledWith("some:event", 42);
  });

  it("executes AUTO_SEND_QUEUED effect", () => {
    const deps = makeDeps();
    const session = makeSession();

    executeEffects([{ type: "AUTO_SEND_QUEUED" }], session, deps);

    expect(deps.queueHandler.autoSendQueuedMessage).toHaveBeenCalledWith(session);
  });

  it("does nothing for empty effects list", () => {
    const deps = makeDeps();
    executeEffects([], makeSession(), deps);
    expect(deps.broadcaster.broadcast).not.toHaveBeenCalled();
    expect(deps.emitEvent).not.toHaveBeenCalled();
  });

  it("SEND_TO_BACKEND effect calls backendConnector.sendToBackend", () => {
    const deps = makeDeps();
    const session = makeSession("s1");
    const msg = createUnifiedMessage({
      type: "user_message",
      role: "user",
      content: [{ type: "text", text: "hello" }],
      metadata: {},
    });

    executeEffects([{ type: "SEND_TO_BACKEND", message: msg }], session, deps);

    expect(deps.backendConnector.sendToBackend).toHaveBeenCalledWith(session, msg);
  });

  it("PERSIST_NOW effect calls store.persist", () => {
    const deps = makeDeps();
    const session = makeSession("s1");

    executeEffects([{ type: "PERSIST_NOW" }], session, deps);

    expect(deps.store.persist).toHaveBeenCalledWith(session);
  });

  it("executes multiple effects in order", () => {
    const deps = makeDeps();
    const session = makeSession();
    const order: string[] = [];
    deps.broadcaster.broadcast.mockImplementation(() => order.push("broadcast"));
    deps.queueHandler.autoSendQueuedMessage.mockImplementation(() => order.push("auto_send"));

    executeEffects(
      [
        { type: "BROADCAST", message: { type: "status_change", status: "idle" } as any },
        { type: "AUTO_SEND_QUEUED" },
      ],
      session,
      deps,
    );

    expect(order).toEqual(["broadcast", "auto_send"]);
  });
});
