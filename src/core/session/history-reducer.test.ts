import { describe, expect, it } from "vitest";
import type { ConsumerMessage } from "../../types/consumer-messages.js";
import {
  appendUserMessage,
  trimHistory,
  upsertAssistantMessage,
  upsertToolUseSummary,
} from "./history-reducer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAssistant(
  id: string,
  opts: { parentToolUseId?: string; model?: string; stopReason?: string; text?: string } = {},
): Extract<ConsumerMessage, { type: "assistant" }> {
  return {
    type: "assistant",
    message: {
      id,
      content: [{ type: "text", text: opts.text ?? "hello" }],
      model: opts.model ?? "claude-opus-4-6",
      stop_reason: opts.stopReason ?? "end_turn",
    } as any,
    parent_tool_use_id: opts.parentToolUseId,
  };
}

function makeSummary(
  toolUseId: string | undefined,
  summary = "done",
): Extract<ConsumerMessage, { type: "tool_use_summary" }> {
  return {
    type: "tool_use_summary",
    tool_use_ids: toolUseId ? [toolUseId] : [],
    tool_use_id: toolUseId,
    summary,
    status: "success",
    is_error: false,
  };
}

function userMsg(content = "hello"): Extract<ConsumerMessage, { type: "user_message" }> {
  return { type: "user_message", content };
}

describe("appendUserMessage", () => {
  it("appends message to empty history", () => {
    const result = appendUserMessage([], userMsg("hi"), 10);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "user_message", content: "hi" });
  });

  it("appends to existing history", () => {
    const result = appendUserMessage([userMsg("first")], userMsg("second"), 10);
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ content: "second" });
  });

  it("trims when appended history exceeds maxLength", () => {
    const history = [userMsg("a"), userMsg("b"), userMsg("c")];
    const result = appendUserMessage(history, userMsg("d"), 3);
    expect(result).toHaveLength(3);
    // oldest entry dropped
    expect(result[0]).toMatchObject({ content: "b" });
    expect(result[2]).toMatchObject({ content: "d" });
  });

  it("does not trim when at exact maxLength after append", () => {
    const result = appendUserMessage([userMsg("a")], userMsg("b"), 2);
    expect(result).toHaveLength(2);
  });
});

describe("trimHistory", () => {
  it("returns same reference when history is under maxLength", () => {
    const history: ConsumerMessage[] = [userMsg("a"), userMsg("b")];
    expect(trimHistory(history, 5)).toBe(history);
  });

  it("returns same reference when history equals maxLength", () => {
    const history: ConsumerMessage[] = [userMsg("a"), userMsg("b")];
    expect(trimHistory(history, 2)).toBe(history);
  });

  it("removes oldest entries to reach maxLength", () => {
    const history: ConsumerMessage[] = [userMsg("a"), userMsg("b"), userMsg("c"), userMsg("d")];
    const result = trimHistory(history, 2);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ content: "c" });
    expect(result[1]).toMatchObject({ content: "d" });
  });

  it("returns new array when trimming occurs", () => {
    const history: ConsumerMessage[] = [userMsg("a"), userMsg("b"), userMsg("c")];
    const result = trimHistory(history, 2);
    expect(result).not.toBe(history);
  });
});

// ---------------------------------------------------------------------------
// upsertAssistantMessage — branch coverage
// ---------------------------------------------------------------------------

describe("upsertAssistantMessage", () => {
  it("appends when history is empty", () => {
    const msg = makeAssistant("m1");
    const result = upsertAssistantMessage([], msg);
    expect(result).toHaveLength(1);
  });

  it("skips non-assistant items while scanning backwards (line 60 continue branch)", () => {
    // The matching item is at index 0; a non-assistant item at index 1 comes after it.
    // The backward scan hits index 1 first → continue, then finds the match at index 0.
    const existing = makeAssistant("m1", { text: "old" });
    const nonAssistant: ConsumerMessage = userMsg("text");
    const updated = makeAssistant("m1", { text: "new" });
    const result = upsertAssistantMessage([existing, nonAssistant], updated);
    expect(result).toHaveLength(2);
    expect((result[0] as any).message.content[0].text).toBe("new");
  });

  it("replaces in history when message is updated", () => {
    const existing = makeAssistant("m1", { text: "old" });
    const updated = makeAssistant("m1", { text: "new" });
    const result = upsertAssistantMessage([existing], updated);
    expect(result).toHaveLength(1);
    expect((result[0] as any).message.content[0].text).toBe("new");
  });

  it("returns same reference when message is equivalent", () => {
    const msg = makeAssistant("m1");
    const history: readonly ConsumerMessage[] = [msg];
    expect(upsertAssistantMessage(history, { ...msg })).toBe(history);
  });

  it("replaces when parent_tool_use_id differs (line 114 return false branch)", () => {
    const existing = makeAssistant("m1", { parentToolUseId: "tu-1" });
    const updated = makeAssistant("m1", { parentToolUseId: "tu-2" });
    const result = upsertAssistantMessage([existing], updated);
    expect((result[0] as any).parent_tool_use_id).toBe("tu-2");
  });

  it("replaces when model differs (line 116 return false branch)", () => {
    const existing = makeAssistant("m1", { model: "gpt-4" });
    const updated = makeAssistant("m1", { model: "gpt-5" });
    const result = upsertAssistantMessage([existing], updated);
    expect((result[0] as any).message.model).toBe("gpt-5");
  });

  it("replaces when stop_reason differs (line 117 return false branch)", () => {
    const existing = makeAssistant("m1", { stopReason: "end_turn" });
    const updated = makeAssistant("m1", { stopReason: "tool_use" });
    const result = upsertAssistantMessage([existing], updated);
    expect((result[0] as any).message.stop_reason).toBe("tool_use");
  });
});

// ---------------------------------------------------------------------------
// upsertToolUseSummary — branch coverage
// ---------------------------------------------------------------------------

describe("upsertToolUseSummary", () => {
  it("appends when history is empty", () => {
    const msg = makeSummary("tu-1");
    expect(upsertToolUseSummary([], msg)).toHaveLength(1);
  });

  it("appends when toolUseId is undefined (line 86 false branch — no id lookup)", () => {
    const msg = makeSummary(undefined);
    const history: ConsumerMessage[] = [makeSummary("tu-1") as ConsumerMessage];
    const result = upsertToolUseSummary(history, msg);
    expect(result).toHaveLength(2);
  });

  it("skips non-summary items while scanning (line 89 continue branch)", () => {
    const nonSummary: ConsumerMessage = userMsg("hi");
    const msg = makeSummary("tu-1");
    const result = upsertToolUseSummary([nonSummary], msg);
    expect(result).toHaveLength(2);
  });

  it("skips items with different toolUseId (line 91 continue branch)", () => {
    const other = makeSummary("tu-other") as ConsumerMessage;
    const msg = makeSummary("tu-1");
    const result = upsertToolUseSummary([other], msg);
    // appended, not replaced
    expect(result).toHaveLength(2);
    expect((result[1] as any).tool_use_id).toBe("tu-1");
  });

  it("derives itemId from tool_use_ids[0] when tool_use_id is absent (line 90 ?? branch)", () => {
    // item has no tool_use_id but has tool_use_ids: the ?? fallback path is taken
    const itemWithIdsOnly: ConsumerMessage = {
      type: "tool_use_summary",
      tool_use_ids: ["tu-x"],
      summary: "done",
      status: "success",
      is_error: false,
    };
    const msg = makeSummary("tu-x", "updated");
    const result = upsertToolUseSummary([itemWithIdsOnly], msg);
    // IDs match via tool_use_ids[0] → should update in-place
    expect(result).toHaveLength(1);
    expect((result[0] as any).summary).toBe("updated");
  });

  it("replaces matching summary with updated content", () => {
    const existing = makeSummary("tu-1") as ConsumerMessage;
    const updated = makeSummary("tu-1", "updated summary");
    const result = upsertToolUseSummary([existing], updated);
    expect(result).toHaveLength(1);
    expect((result[0] as any).summary).toBe("updated summary");
  });

  it("returns same reference when summary is equivalent", () => {
    const msg = makeSummary("tu-1");
    const history: readonly ConsumerMessage[] = [msg as ConsumerMessage];
    expect(upsertToolUseSummary(history, { ...msg })).toBe(history);
  });
});
