import { describe, expect, it } from "vitest";
import type { ConsumerMessage } from "../../types/consumer-messages.js";
import type { SessionState } from "../../types/session-state.js";
import { mapAssistantMessage } from "../messaging/consumer-message-mapper.js";
import { TeamToolCorrelationBuffer } from "../team/team-tool-correlation.js";
import { createUnifiedMessage } from "../types/unified-message.js";
import type { SessionData } from "./session-data.js";
import { reduce, reduceSessionData } from "./session-state-reducer.js";

/** Minimal valid SessionData for testing. */
function baseData(): SessionData {
  return {
    state: baseState(),
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
    const next = reduceSessionData(data, msg, buffer);
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
    const next = reduceSessionData(data, msg, buffer);
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
    const next = reduceSessionData(data, msg, buffer);
    expect(next.lastStatus).toBe("idle");
  });

  it("returns same reference when status unchanged", () => {
    const data = { ...baseData(), lastStatus: "idle" as const };
    const msg = createUnifiedMessage({
      type: "status_change",
      role: "assistant",
      metadata: { status: "idle" },
    });
    const buffer = new TeamToolCorrelationBuffer();
    const next = reduceSessionData(data, msg, buffer);
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
    const next = reduceSessionData(data, msg, buffer);
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
      const next = reduceSessionData(data, msg, buffer);
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
      const next = reduceSessionData(data, msg, buffer);
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
      const next = reduceSessionData(data, msg, buffer);
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
      const next = reduceSessionData(data, m, buffer); // Renamed from state
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
      const next = reduceSessionData(data, m, buffer); // Renamed from state
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
      const next = reduceSessionData(data, m, buffer); // Renamed from state
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
      const next = reduceSessionData(data, m, buffer); // Renamed from state
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
      const next = reduceSessionData(data, second, buffer);
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
      const next = reduceSessionData(data, same, buffer);
      expect(next.messageHistory).toBe(data.messageHistory);
    });
  });
});
