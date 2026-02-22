import { describe, expect, it, vi } from "vitest";
import { BufferedWebSocket } from "./buffered-websocket.js";

function createSocket() {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    send: vi.fn(),
    close: vi.fn(),
    bufferedAmount: 7,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handlers[event] || [];
      handlers[event].push(handler);
    }),
    emit(event: "message" | "close" | "error", payload?: unknown) {
      for (const handler of handlers[event] || []) {
        if (event === "close") {
          handler();
        } else if (event === "error") {
          handler(payload ?? new Error("boom"));
        } else {
          handler(payload);
        }
      }
    },
  };
}

describe("BufferedWebSocket", () => {
  it("replays buffered messages in order when first message handler is registered", () => {
    const socket = createSocket();
    const buffered = new BufferedWebSocket(socket as any).asSocket();

    socket.emit("message", "early-1");
    socket.emit("message", "early-2");

    const received: unknown[] = [];
    buffered.on("message", (data) => received.push(data));
    socket.emit("message", "late-1");

    expect(received).toEqual(["early-1", "early-2", "late-1"]);
  });

  it("replays only once across multiple message handler registrations", () => {
    const socket = createSocket();
    const buffered = new BufferedWebSocket(socket as any).asSocket();

    socket.emit("message", "early");

    const first: unknown[] = [];
    buffered.on("message", (data) => first.push(data));

    const second: unknown[] = [];
    buffered.on("message", (data) => second.push(data));
    socket.emit("message", "late");

    expect(first).toEqual(["early", "late"]);
    expect(second).toEqual(["late"]);
  });

  it("drops buffered messages if socket closes before first message handler registration", () => {
    const socket = createSocket();
    const buffered = new BufferedWebSocket(socket as any).asSocket();

    socket.emit("message", "early");
    socket.emit("close");

    const received: unknown[] = [];
    buffered.on("message", (data) => received.push(data));
    socket.emit("message", "late");

    expect(received).toEqual(["late"]);
  });

  it("proxies send/close/bufferedAmount to the underlying socket", () => {
    const socket = createSocket();
    const buffered = new BufferedWebSocket(socket as any).asSocket();

    buffered.send("hello");
    buffered.close(1000, "done");

    expect(buffered.bufferedAmount).toBe(7);
    expect(socket.send).toHaveBeenCalledWith("hello");
    expect(socket.close).toHaveBeenCalledWith(1000, "done");
  });
});
