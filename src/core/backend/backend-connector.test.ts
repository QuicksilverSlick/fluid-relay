import { describe, expect, it, vi } from "vitest";
import type { BackendConnectorDeps } from "./backend-connector.js";
import { BackendConnector } from "./backend-connector.js";

function createMockRuntime() {
  return {
    getBackendSession: vi.fn(() => null),
    getBackendAbort: vi.fn(() => null),
    peekPendingPassthrough: vi.fn(() => undefined),
    shiftPendingPassthrough: vi.fn(() => undefined),
    getState: vi.fn(() => ({ slash_commands: [] })),
    setState: vi.fn(),
    registerSlashCommandNames: vi.fn(),
  };
}

function createDeps(overrides?: Partial<BackendConnectorDeps>): BackendConnectorDeps {
  const mockRuntime = createMockRuntime();
  return {
    adapter: {
      name: "test",
      capabilities: {
        streaming: true,
        permissions: true,
        slashCommands: false,
        availability: "local",
        teams: false,
      },
      connect: vi.fn().mockResolvedValue({
        sessionId: "s1",
        send: vi.fn(),
        initialize: vi.fn(),
        messages: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
        close: vi.fn().mockResolvedValue(undefined),
      }),
    } as any,
    adapterResolver: null,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    metrics: null,
    routeUnifiedMessage: vi.fn(),
    routeSystemSignal: vi.fn(),
    emitEvent: vi.fn(),
    getRuntime: () => mockRuntime as any,
    ...overrides,
  };
}

describe("BackendConnector", () => {
  it("delegates lifecycle operations to underlying manager", async () => {
    const deps = createDeps();
    const connector = new BackendConnector(deps);
    const session = { id: "s1", data: { adapterName: undefined } } as any;
    session.data = session;

    expect(connector.hasAdapter).toBe(true);
    await connector.connectBackend(session, { resume: true });
    connector.sendToBackend(session, { type: "interrupt", role: "system", metadata: {} } as any);
    expect(() => connector.isBackendConnected(session)).not.toThrow();
    await connector.disconnectBackend(session);
  });

  // ── streamEventTextChunk branch coverage (lines 176-187) ──────────────────

  it("streamEventTextChunk returns '' for all uncovered branch paths (lines 176-187)", () => {
    const connector = new BackendConnector(createDeps());
    const chunk = (msg: object) => (connector as any).streamEventTextChunk(msg);

    // Line 166: non-stream_event → ""
    expect(chunk({ type: "assistant", metadata: {} })).toBe("");

    // Line 168: event is not an object
    expect(chunk({ type: "stream_event", metadata: { event: "not-object" } })).toBe("");

    // Line 168: event is null
    expect(chunk({ type: "stream_event", metadata: { event: null } })).toBe("");

    // Line 173: content_block_delta with non-object delta
    expect(
      chunk({
        type: "stream_event",
        metadata: { event: { type: "content_block_delta", delta: null } },
      }),
    ).toBe("");

    // Line 176: content_block_delta delta exists but has no text field
    expect(
      chunk({
        type: "stream_event",
        metadata: { event: { type: "content_block_delta", delta: { type: "input_json_delta" } } },
      }),
    ).toBe("");

    // Line 181: content_block_start with null block
    expect(
      chunk({
        type: "stream_event",
        metadata: { event: { type: "content_block_start", content_block: null } },
      }),
    ).toBe("");

    // Line 184: content_block_start with non-text block type
    expect(
      chunk({
        type: "stream_event",
        metadata: { event: { type: "content_block_start", content_block: { type: "tool_use" } } },
      }),
    ).toBe("");

    // Line 184: content_block_start with text type but text is not a string
    expect(
      chunk({
        type: "stream_event",
        metadata: {
          event: { type: "content_block_start", content_block: { type: "text", text: 42 } },
        },
      }),
    ).toBe("");

    // Line 187: unknown event type
    expect(chunk({ type: "stream_event", metadata: { event: { type: "message_start" } } })).toBe(
      "",
    );
  });

  // ── connectBackend re-connect: existing session close() error (line 413) ───

  it("connectBackend logs warning when closing existing session throws (line 413)", async () => {
    const failingClose = vi.fn().mockRejectedValue(new Error("close failed"));
    const existingSession = { close: failingClose } as any;

    const mockRuntime = createMockRuntime();
    mockRuntime.getBackendSession.mockReturnValue(existingSession);
    mockRuntime.getBackendAbort.mockReturnValue({ abort: vi.fn() } as any);

    const deps = createDeps({
      getRuntime: () => mockRuntime as any,
    });
    const connector = new BackendConnector(deps);
    const session = { id: "s-reconnect", data: { adapterName: undefined } } as any;
    session.data = session;

    // Should not throw — the close error is caught and logged (line 413)
    await expect(connector.connectBackend(session)).resolves.not.toThrow();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      "Failed to close backend session",
      expect.objectContaining({ sessionId: "s-reconnect" }),
    );
  });

  // ── disconnectBackend: session close() error (line 513) ───────────────────

  it("disconnectBackend logs warning when session.close() throws (line 513)", async () => {
    const failingClose = vi.fn().mockRejectedValue(new Error("disconnect close failed"));
    const backendSession = { close: failingClose } as any;

    const mockRuntime = createMockRuntime();
    mockRuntime.getBackendSession.mockReturnValue(backendSession);
    mockRuntime.getBackendAbort.mockReturnValue({ abort: vi.fn() } as any);

    const deps = createDeps({
      getRuntime: () => mockRuntime as any,
    });
    const connector = new BackendConnector(deps);
    const session = { id: "s-disco", data: { adapterName: undefined } } as any;
    session.data = session;

    // Should not throw — the close error is caught and logged (line 513)
    await expect(connector.disconnectBackend(session)).resolves.not.toThrow();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      "Failed to close backend session",
      expect.objectContaining({ sessionId: "s-disco" }),
    );
  });
});
