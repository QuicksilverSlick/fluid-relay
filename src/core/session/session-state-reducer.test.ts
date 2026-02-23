import { describe, expect, it } from "vitest";
import type { ConsumerMessage } from "../../types/consumer-messages.js";
import type { SessionState } from "../../types/session-state.js";
import { mapAssistantMessage } from "../messaging/consumer-message-mapper.js";
import { TeamToolCorrelationBuffer } from "../team/team-tool-correlation.js";
import { createUnifiedMessage } from "../types/unified-message.js";
import type { SessionData } from "./session-data.js";
import { sessionReducer } from "./session-reducer.js";
import { reduce } from "./session-state-reducer.js";

/** Minimal valid SessionData for testing. */
function baseData(): SessionData {
  return {
    state: baseState(),
    lifecycle: "active",
    pendingPermissions: new Map(),
    messageHistory: [],
    pendingMessages: [],
    queuedMessage: null,
    lastStatus: null,
    adapterSupportsSlashPassthrough: false,
  };
}

/** Minimal valid SessionState for testing. */
function baseState() {
  return {
    model: "claude-sonnet-4-5-20250929",
    cwd: "/tmp",
    tools: [],
    permissionMode: "default",
    claude_code_version: "1.0.0",
    mcp_servers: [],
    slash_commands: [],
    skills: [],
    is_compacting: false,
    total_cost_usd: 0,
    num_turns: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    last_duration_ms: 0,
    last_duration_api_ms: 0,
    context_used_percent: 0,
  } as unknown as SessionState;
}

describe("reduce — configuration_change", () => {
  it("updates model from metadata.model", () => {
    const state = baseState();
    const msg = createUnifiedMessage({
      type: "configuration_change",
      role: "user",
      metadata: { subtype: "set_model", model: "gpt-4" },
    });

    const next = reduce(state, msg);
    expect(next.model).toBe("gpt-4");
    expect(next).not.toBe(state);
  });

  it("updates permissionMode from metadata.mode (consumer path)", () => {
    const state = baseState();
    const msg = createUnifiedMessage({
      type: "configuration_change",
      role: "user",
      metadata: { subtype: "set_permission_mode", mode: "plan" },
    });

    const next = reduce(state, msg);
    expect(next.permissionMode).toBe("plan");
    expect(next).not.toBe(state);
  });

  it("updates permissionMode from metadata.permissionMode (adapter path)", () => {
    const state = baseState();
    const msg = createUnifiedMessage({
      type: "configuration_change",
      role: "system",
      metadata: { permissionMode: "bypassPermissions" },
    });

    const next = reduce(state, msg);
    expect(next.permissionMode).toBe("bypassPermissions");
  });

  it("prefers metadata.mode over metadata.permissionMode", () => {
    const state = baseState();
    const msg = createUnifiedMessage({
      type: "configuration_change",
      role: "user",
      metadata: { mode: "plan", permissionMode: "bypassPermissions" },
    });

    const next = reduce(state, msg);
    expect(next.permissionMode).toBe("plan");
  });

  it("returns same reference when nothing changed", () => {
    const state = baseState();
    const msg = createUnifiedMessage({
      type: "configuration_change",
      role: "system",
      metadata: { subtype: "available_commands_update" },
    });

    const next = reduce(state, msg);
    expect(next).toBe(state);
  });

  it("returns same reference when values are unchanged", () => {
    const state = baseState();
    const msg = createUnifiedMessage({
      type: "configuration_change",
      role: "user",
      metadata: { model: state.model, mode: state.permissionMode },
    });

    const next = reduce(state, msg);
    expect(next).toBe(state);
  });
});

describe("reduceSessionData", () => {
  it("returns same reference when nothing changes", () => {
    const data = baseData();
    const msg = createUnifiedMessage({ type: "interrupt", role: "system", metadata: {} });
    const buffer = new TeamToolCorrelationBuffer();
    const [next] = sessionReducer(data, { type: "BACKEND_MESSAGE", message: msg }, buffer);
    expect(next).toBe(data);
  });

  it("sets lastStatus to running on status_change running", () => {
    const data = baseData();
    const msg = createUnifiedMessage({
      type: "status_change",
      role: "assistant",
      metadata: { status: "running" },
    });
    const buffer = new TeamToolCorrelationBuffer();
    const [next] = sessionReducer(data, { type: "BACKEND_MESSAGE", message: msg }, buffer);
    expect(next.lastStatus).toBe("running");
    expect(next).not.toBe(data);
  });

  it("sets lastStatus to idle on result message", () => {
    const data = { ...baseData(), lastStatus: "running" as const };
    const msg = createUnifiedMessage({
      type: "result",
      role: "assistant",
      metadata: { subtype: "success" },
    });
    const buffer = new TeamToolCorrelationBuffer();
    const [next] = sessionReducer(data, { type: "BACKEND_MESSAGE", message: msg }, buffer);
    expect(next.lastStatus).toBe("idle");
  });

  it("returns same reference when status unchanged", () => {
    const data = { ...baseData(), lastStatus: "idle" as const, lifecycle: "idle" as const };
    const msg = createUnifiedMessage({
      type: "status_change",
      role: "assistant",
      metadata: { status: "idle" },
    });
    const buffer = new TeamToolCorrelationBuffer();
    const [next] = sessionReducer(data, { type: "BACKEND_MESSAGE", message: msg }, buffer);
    expect(next).toBe(data); // no change, same ref
  });

  it("extracts backendSessionId from session_init", () => {
    const data = baseData();
    const msg = createUnifiedMessage({
      type: "session_init",
      role: "assistant",
      metadata: { session_id: "cli-abc-123", model: "claude-sonnet-4-6" },
    });
    const buffer = new TeamToolCorrelationBuffer();
    const [next] = sessionReducer(data, { type: "BACKEND_MESSAGE", message: msg }, buffer);
    expect(next.backendSessionId).toBe("cli-abc-123");
  });

  describe("pendingPermissions", () => {
    it("stores permission request from permission_request message", () => {
      const data = baseData();
      const msg = createUnifiedMessage({
        type: "permission_request",
        role: "assistant",
        metadata: {
          request_id: "req-1",
          tool_name: "bash",
          input: { command: "ls" },
        },
      });
      const buffer = new TeamToolCorrelationBuffer();
      const [next] = sessionReducer(data, { type: "BACKEND_MESSAGE", message: msg }, buffer);
      expect(next.pendingPermissions.get("req-1")).toMatchObject({ tool_name: "bash" });
    });

    it("removes permission request on permission_response", () => {
      const permissions = new Map([["req-1", { tool_name: "bash", request_id: "req-1" } as any]]);
      const data = { ...baseData(), pendingPermissions: permissions };
      const msg = createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: { request_id: "req-1", behavior: "allow" },
      });
      const buffer = new TeamToolCorrelationBuffer();
      const [next] = sessionReducer(data, { type: "BACKEND_MESSAGE", message: msg }, buffer);
      expect(next.pendingPermissions.has("req-1")).toBe(false);
    });
  });

  describe("reduceSessionData — messageHistory (assistant)", () => {
    it("appends new assistant message to history", () => {
      const data = baseData();
      const msg = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        metadata: {},
      });
      const buffer = new TeamToolCorrelationBuffer();
      const [next] = sessionReducer(data, { type: "BACKEND_MESSAGE", message: msg }, buffer);
      expect(next.messageHistory).toHaveLength(1);
      expect(next.messageHistory[0]).toMatchObject({ type: "assistant" });
    });

    it("appends result messages", () => {
      const data = baseData();
      const m = createUnifiedMessage({
        type: "result",
        role: "tool",
        metadata: {
          subtype: "success",
          num_turns: 1,
          is_error: false,
        },
      });
      const buffer = new TeamToolCorrelationBuffer(); // Renamed from correlationBuffer
      const [next] = sessionReducer(data, { type: "BACKEND_MESSAGE", message: m }, buffer); // Renamed from state
      expect(next.messageHistory).toHaveLength(1);
      expect(next.messageHistory[0].type).toBe("result");
    });

    it("appends new tool use summary", () => {
      const data = baseData();
      const m = createUnifiedMessage({
        type: "tool_use_summary",
        role: "system",
        metadata: {
          summary: "Ran command",
          tool_use_id: "tu-1",
          output: "ok",
        },
      });
      const buffer = new TeamToolCorrelationBuffer(); // Renamed from correlationBuffer
      const [next] = sessionReducer(data, { type: "BACKEND_MESSAGE", message: m }, buffer); // Renamed from state
      expect(next.messageHistory).toHaveLength(1);
      expect(next.messageHistory[0].type).toBe("tool_use_summary");
    });

    it("updates existing tool use summary with same tool_use_id", () => {
      const initialSummary: ConsumerMessage = {
        type: "tool_use_summary",
        tool_use_id: "tu-1",
        tool_use_ids: ["tu-1"],
        summary: "Running",
        output: "line 1",
        status: "success",
        is_error: false,
      };
      const data = { ...baseData(), messageHistory: [initialSummary] };

      const m = createUnifiedMessage({
        type: "tool_use_summary",
        role: "system",
        metadata: {
          summary: "Finished",
          tool_use_id: "tu-1",
          tool_use_ids: ["tu-1"],
          output: "line 1\nline 2",
          status: "success",
          is_error: false,
        },
      });

      const buffer = new TeamToolCorrelationBuffer(); // Renamed from correlationBuffer
      const [next] = sessionReducer(data, { type: "BACKEND_MESSAGE", message: m }, buffer); // Renamed from state
      expect(next.messageHistory).toHaveLength(1);
      expect((next.messageHistory[0] as any).summary).toBe("Finished");
      expect((next.messageHistory[0] as any).output).toBe("line 1\nline 2");
    });

    it("skips equivalent tool use summary", () => {
      const initialSummary: ConsumerMessage = {
        type: "tool_use_summary",
        tool_use_id: "tu-1",
        tool_use_ids: ["tu-1"],
        summary: "Running",
        output: "line 1",
        status: "success",
        is_error: false,
      };
      const data = { ...baseData(), messageHistory: [initialSummary] };

      const m = createUnifiedMessage({
        type: "tool_use_summary",
        role: "system",
        metadata: {
          summary: "Running",
          tool_use_id: "tu-1",
          tool_use_ids: ["tu-1"],
          output: "line 1",
          status: "success",
          is_error: false,
        },
      });

      const buffer = new TeamToolCorrelationBuffer(); // Renamed from correlationBuffer
      const [next] = sessionReducer(data, { type: "BACKEND_MESSAGE", message: m }, buffer); // Renamed from state
      expect(next).toBe(data); // Reference equality means no change
    });

    it("replaces existing message if same message.id (streaming update)", () => {
      const messageId = "msg_abc123";
      const first = mapAssistantMessage(
        createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [{ type: "text", text: "hel" }],
          metadata: { message_id: messageId },
        }),
      )!;
      const data = { ...baseData(), messageHistory: [first] };
      const second = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        metadata: { message_id: messageId },
      });
      const buffer = new TeamToolCorrelationBuffer();
      const [next] = sessionReducer(data, { type: "BACKEND_MESSAGE", message: second }, buffer);
      expect(next.messageHistory).toHaveLength(1);
      expect((next.messageHistory[0] as any).message.content[0].text).toBe("hello");
    });

    it("skips update if message content is equivalent", () => {
      const messageId = "msg_abc123";
      const mapped = mapAssistantMessage(
        createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          metadata: { message_id: messageId },
        }),
      )!;
      const data = { ...baseData(), messageHistory: [mapped] };
      const same = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        metadata: { message_id: messageId },
      });
      const buffer = new TeamToolCorrelationBuffer();
      const [next] = sessionReducer(data, { type: "BACKEND_MESSAGE", message: same }, buffer);
      expect(next.messageHistory).toBe(data.messageHistory);
    });
  });
});

// ---------------------------------------------------------------------------
// session-state-reducer: uncovered branch coverage
// ---------------------------------------------------------------------------

describe("reduce — session_init with non-array fields (asStringArray fallback)", () => {
  it("falls back to existing tools when tools is not an array", () => {
    const state = baseState();
    const msg = createUnifiedMessage({
      type: "session_init",
      role: "assistant",
      metadata: { model: "claude-4", tools: "not-an-array" },
    });
    const next = reduce(state, msg);
    expect(next.tools).toEqual(state.tools);
  });

  it("falls back to existing slash_commands when slash_commands is not an array", () => {
    const state = baseState();
    const msg = createUnifiedMessage({
      type: "session_init",
      role: "assistant",
      metadata: { slash_commands: 42 },
    });
    const next = reduce(state, msg);
    expect(next.slash_commands).toEqual(state.slash_commands);
  });

  it("filters array tools, keeping only strings (asStringArray true branch)", () => {
    const state = baseState();
    const msg = createUnifiedMessage({
      type: "session_init",
      role: "assistant",
      metadata: { tools: ["bash", "read", 42, null] },
    });
    const next = reduce(state, msg);
    expect(next.tools).toEqual(["bash", "read"]);
  });
});

describe("reduce — reduceStatusChange compacting branch", () => {
  it("sets is_compacting to true when status is compacting", () => {
    const state = baseState();
    const msg = createUnifiedMessage({
      type: "status_change",
      role: "assistant",
      metadata: { status: "compacting" },
    });
    const next = reduce(state, msg);
    expect(next.is_compacting).toBe(true);
    expect(next).not.toBe(state);
  });

  it("clears is_compacting when status returns to running after compacting", () => {
    const compactingState = { ...baseState(), is_compacting: true };
    const msg = createUnifiedMessage({
      type: "status_change",
      role: "assistant",
      metadata: { status: "running" },
    });
    const next = reduce(compactingState, msg);
    expect(next.is_compacting).toBe(false);
  });
});

describe("reduce — control_response returns state unchanged", () => {
  it("returns same state reference for control_response", () => {
    const state = baseState();
    const msg = createUnifiedMessage({
      type: "control_response",
      role: "assistant",
      metadata: { request_id: "req-1", capabilities: {} },
    });
    const next = reduce(state, msg);
    // reduceControlResponse is a no-op — state is unchanged
    expect(next).toBe(state);
  });
});

describe("reduce — tool_result with no buffered correlation", () => {
  it("ignores tool_result blocks that do not correlate with a buffered tool_use", () => {
    const state = baseState();
    // Provide a tool_result in content with an empty correlation buffer → onToolResult returns null
    const msg = createUnifiedMessage({
      type: "assistant",
      role: "assistant",
      content: [{ type: "tool_result", tool_use_id: "unknown-id", content: "output" }],
      metadata: {},
    });
    const buffer = new TeamToolCorrelationBuffer();
    // Should not throw and should return stable state
    const next = reduce(state, msg, buffer);
    expect(next).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// session-reducer: buildEffects uncovered branches
// ---------------------------------------------------------------------------

describe("sessionReducer BACKEND_MESSAGE — configuration_change effects", () => {
  it("emits BROADCAST and BROADCAST_SESSION_UPDATE when model changes", () => {
    const data = baseData();
    const msg = createUnifiedMessage({
      type: "configuration_change",
      role: "system",
      metadata: { model: "gpt-4-turbo" },
    });
    const buffer = new TeamToolCorrelationBuffer();
    const [, effects] = sessionReducer(data, { type: "BACKEND_MESSAGE", message: msg }, buffer);

    const types = effects.map((e) => e.type);
    expect(types).toContain("BROADCAST");
    expect(types).toContain("BROADCAST_SESSION_UPDATE");
    const update = effects.find((e) => e.type === "BROADCAST_SESSION_UPDATE") as any;
    expect(update.patch.model).toBe("gpt-4-turbo");
  });

  it("emits only BROADCAST when metadata has no model or mode", () => {
    const data = baseData();
    const msg = createUnifiedMessage({
      type: "configuration_change",
      role: "system",
      metadata: { subtype: "available_commands_update" },
    });
    const buffer = new TeamToolCorrelationBuffer();
    const [, effects] = sessionReducer(data, { type: "BACKEND_MESSAGE", message: msg }, buffer);

    expect(effects.map((e) => e.type)).toEqual(["BROADCAST"]);
  });

  it("includes permissionMode in BROADCAST_SESSION_UPDATE patch when mode changes", () => {
    const data = baseData();
    const msg = createUnifiedMessage({
      type: "configuration_change",
      role: "system",
      metadata: { permissionMode: "bypassPermissions" },
    });
    const buffer = new TeamToolCorrelationBuffer();
    const [, effects] = sessionReducer(data, { type: "BACKEND_MESSAGE", message: msg }, buffer);

    const update = effects.find((e) => e.type === "BROADCAST_SESSION_UPDATE") as any;
    expect(update?.patch.permissionMode).toBe("bypassPermissions");
  });
});

describe("reduce — reduceResult metrics (lines 115-125)", () => {
  it("sets total_lines_added and total_lines_removed from result message", () => {
    const state = baseState();
    const msg = createUnifiedMessage({
      type: "result",
      role: "assistant",
      metadata: { subtype: "success", total_lines_added: 50, total_lines_removed: 20 },
    });
    const next = reduce(state, msg);
    expect(next.total_lines_added).toBe(50);
    expect(next.total_lines_removed).toBe(20);
  });

  it("sets duration fields from result message", () => {
    const state = baseState();
    const msg = createUnifiedMessage({
      type: "result",
      role: "assistant",
      metadata: { subtype: "success", duration_ms: 1500, duration_api_ms: 800 },
    });
    const next = reduce(state, msg);
    expect(next.last_duration_ms).toBe(1500);
    expect(next.last_duration_api_ms).toBe(800);
  });
});

describe("reduce — reduceResult with modelUsage (lines 143-151)", () => {
  it("sets last_model_usage and context_used_percent from modelUsage", () => {
    const state = baseState();
    const modelUsage = {
      "claude-opus-4-6": {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        contextWindow: 200000,
        costUSD: 0.01,
      },
    };
    const msg = createUnifiedMessage({
      type: "result",
      role: "assistant",
      metadata: { subtype: "success", modelUsage },
    });
    const next = reduce(state, msg);
    expect(next.last_model_usage).toEqual(modelUsage);
    expect(next.context_used_percent).toBe(1); // (1000+200)/200000 = 0.6% → rounds to 1
  });

  it("skips context_used_percent when contextWindow is 0", () => {
    const state = baseState();
    const msg = createUnifiedMessage({
      type: "result",
      role: "assistant",
      metadata: {
        subtype: "success",
        modelUsage: {
          model: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            contextWindow: 0,
            costUSD: 0,
          },
        },
      },
    });
    const next = reduce(state, msg);
    expect(next.context_used_percent).toBe(state.context_used_percent);
  });
});

describe("sessionReducer BACKEND_MESSAGE — session_lifecycle effects", () => {
  it("emits BROADCAST effect for session_lifecycle message", () => {
    const data = baseData();
    const msg = createUnifiedMessage({
      type: "session_lifecycle",
      role: "assistant",
      metadata: { subtype: "session_created" },
    });
    const buffer = new TeamToolCorrelationBuffer();
    const [, effects] = sessionReducer(data, { type: "BACKEND_MESSAGE", message: msg }, buffer);
    expect(effects.some((e) => e.type === "BROADCAST")).toBe(true);
  });
});

describe("sessionReducer BACKEND_MESSAGE — reduceLastStatus edge cases", () => {
  it("keeps current status when status_change carries unrecognised status", () => {
    const data = { ...baseData(), lastStatus: "running" as const };
    const msg = createUnifiedMessage({
      type: "status_change",
      role: "assistant",
      metadata: { status: "some_unknown_value" },
    });
    const buffer = new TeamToolCorrelationBuffer();
    const [next] = sessionReducer(data, { type: "BACKEND_MESSAGE", message: msg }, buffer);
    expect(next.lastStatus).toBe("running");
  });

  it("keeps current status on stream_event with message_start inside a sub-agent (parent_tool_use_id set)", () => {
    const data = { ...baseData(), lastStatus: "idle" as const };
    const msg = createUnifiedMessage({
      type: "stream_event",
      role: "assistant",
      metadata: {
        event: { type: "message_start" },
        parent_tool_use_id: "tu-parent",
      },
    });
    const buffer = new TeamToolCorrelationBuffer();
    const [next] = sessionReducer(data, { type: "BACKEND_MESSAGE", message: msg }, buffer);
    expect(next.lastStatus).toBe("idle");
  });
});
