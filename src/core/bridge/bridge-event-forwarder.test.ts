import { describe, expect, it, vi } from "vitest";
import { forwardBridgeEventWithLifecycle } from "./bridge-event-forwarder.js";

describe("forwardBridgeEventWithLifecycle", () => {
  it("mirrors lifecycle signals when payload has string sessionId", () => {
    const runtimeManager = { handleLifecycleSignal: vi.fn() };
    const emit = vi.fn();

    forwardBridgeEventWithLifecycle(runtimeManager as any, emit, "backend:connected", {
      sessionId: "s1",
    });
    forwardBridgeEventWithLifecycle(runtimeManager as any, emit, "backend:disconnected", {
      sessionId: "s2",
    });
    forwardBridgeEventWithLifecycle(runtimeManager as any, emit, "session:closed", {
      sessionId: "s3",
    });

    expect(runtimeManager.handleLifecycleSignal).toHaveBeenNthCalledWith(
      1,
      "s1",
      "backend:connected",
    );
    expect(runtimeManager.handleLifecycleSignal).toHaveBeenNthCalledWith(
      2,
      "s2",
      "backend:disconnected",
    );
    expect(runtimeManager.handleLifecycleSignal).toHaveBeenNthCalledWith(3, "s3", "session:closed");
    expect(emit).toHaveBeenCalledTimes(3);
  });

  it("does not mirror non-lifecycle events", () => {
    const runtimeManager = { handleLifecycleSignal: vi.fn() };
    const emit = vi.fn();

    forwardBridgeEventWithLifecycle(runtimeManager as any, emit, "message:outbound", {
      sessionId: "s1",
    });

    expect(runtimeManager.handleLifecycleSignal).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith("message:outbound", { sessionId: "s1" });
  });

  it("does not mirror when sessionId is missing or non-string", () => {
    const runtimeManager = { handleLifecycleSignal: vi.fn() };
    const emit = vi.fn();

    forwardBridgeEventWithLifecycle(runtimeManager as any, emit, "backend:connected", {});
    forwardBridgeEventWithLifecycle(runtimeManager as any, emit, "backend:connected", {
      sessionId: 42,
    });
    forwardBridgeEventWithLifecycle(runtimeManager as any, emit, "backend:connected", null);

    expect(runtimeManager.handleLifecycleSignal).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(3);
  });
});
