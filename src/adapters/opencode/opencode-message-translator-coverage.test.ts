/**
 * Coverage tests for opencode-message-translator.ts
 *
 * Targets uncovered branches at lines 201, 204-210 (and line 53):
 *   - line 201: `case "tool": return translateToolPart(part)` in translatePartUpdated
 *   - lines 204-210: `case "step-start": case "step-finish":` status_change block,
 *     including the ternary `part.type === "step-start" ? "start" : "finish"`
 *   - line 53: session.compacted branch — the `session_id` field via direct event
 */

import { describe, expect, it } from "vitest";
import { translateEvent } from "./opencode-message-translator.js";
import type { OpencodeEvent } from "./opencode-types.js";

const SESSION_ID = "sess-cov-001";
const MESSAGE_ID = "msg-cov-001";
const PART_ID = "part-cov-001";

// ---------------------------------------------------------------------------
// line 201: case "tool" in translatePartUpdated
// Verify the tool branch is entered via translateEvent with a raw tool part
// using all four tool states to maximise V8 branch tracking.
// ---------------------------------------------------------------------------

describe("coverage: translatePartUpdated — tool part (line 201)", () => {
  it("routes tool part with pending state through the tool case", () => {
    const event: OpencodeEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          id: PART_ID,
          messageID: MESSAGE_ID,
          sessionID: SESSION_ID,
          callID: "call-cov-1",
          tool: "read_file",
          state: { status: "pending", input: { path: "/tmp/x" } },
          time: { created: 1000, updated: 1001 },
        },
      },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("tool_progress");
    expect(msg!.metadata.status).toBe("pending");
    expect(msg!.metadata.tool).toBe("read_file");
    expect(msg!.metadata.tool_use_id).toBe("call-cov-1");
    expect(msg!.metadata.session_id).toBe(SESSION_ID);
  });

  it("routes tool part with running state through the tool case", () => {
    const event: OpencodeEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          id: PART_ID,
          messageID: MESSAGE_ID,
          sessionID: SESSION_ID,
          callID: "call-cov-2",
          tool: "write_file",
          state: {
            status: "running",
            input: { path: "/tmp/y", content: "hello" },
            title: "Writing file",
            time: { start: 2000 },
          },
          time: { created: 1000, updated: 1001 },
        },
      },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("tool_progress");
    expect(msg!.metadata.status).toBe("running");
    expect(msg!.metadata.title).toBe("Writing file");
  });

  it("routes tool part with completed state through the tool case", () => {
    const event: OpencodeEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          id: PART_ID,
          messageID: MESSAGE_ID,
          sessionID: SESSION_ID,
          callID: "call-cov-3",
          tool: "bash",
          state: {
            status: "completed",
            input: { cmd: "echo hi" },
            output: "hi",
            title: "echo",
            time: { start: 2000, end: 3000 },
          },
          time: { created: 1000, updated: 1001 },
        },
      },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("tool_use_summary");
    expect(msg!.metadata.status).toBe("completed");
    expect(msg!.metadata.output).toBe("hi");
  });

  it("routes tool part with error state through the tool case", () => {
    const event: OpencodeEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          id: PART_ID,
          messageID: MESSAGE_ID,
          sessionID: SESSION_ID,
          callID: "call-cov-4",
          tool: "bash",
          state: {
            status: "error",
            input: { cmd: "badcmd" },
            error: "command not found",
            time: { start: 2000, end: 2500 },
          },
          time: { created: 1000, updated: 1001 },
        },
      },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("tool_use_summary");
    expect(msg!.metadata.status).toBe("error");
    expect(msg!.metadata.is_error).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// lines 204-210: case "step-start" / case "step-finish" in translatePartUpdated
// Both the ternary branches `"start"` and `"finish"` must be hit to cover
// lines 204-210 including the inline conditional at line 210.
// ---------------------------------------------------------------------------

describe("coverage: translatePartUpdated — step-start (lines 204-210)", () => {
  it("produces status_change with step=start for step-start part", () => {
    const event: OpencodeEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          type: "step-start",
          id: PART_ID,
          messageID: MESSAGE_ID,
          sessionID: SESSION_ID,
        },
      },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("status_change");
    expect(msg!.role).toBe("system");
    expect(msg!.metadata.step).toBe("start");
    expect(msg!.metadata.step_id).toBe(PART_ID);
    expect(msg!.metadata.message_id).toBe(MESSAGE_ID);
    expect(msg!.metadata.session_id).toBe(SESSION_ID);
  });

  it("produces status_change with step=finish for step-finish part", () => {
    const event: OpencodeEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          type: "step-finish",
          id: PART_ID,
          messageID: MESSAGE_ID,
          sessionID: SESSION_ID,
        },
      },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("status_change");
    expect(msg!.role).toBe("system");
    expect(msg!.metadata.step).toBe("finish");
    expect(msg!.metadata.step_id).toBe(PART_ID);
    expect(msg!.metadata.message_id).toBe(MESSAGE_ID);
    expect(msg!.metadata.session_id).toBe(SESSION_ID);
  });

  it("step-finish part with optional cost/tokens fields is still a status_change", () => {
    const event: OpencodeEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          type: "step-finish",
          id: "step-fin-2",
          messageID: MESSAGE_ID,
          sessionID: SESSION_ID,
          cost: 0.001,
          tokens: { input: 50, output: 100 },
        },
      },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("status_change");
    expect(msg!.metadata.step).toBe("finish");
    expect(msg!.metadata.step_id).toBe("step-fin-2");
  });
});

// ---------------------------------------------------------------------------
// line 53: session.compacted with explicit sessionID value
// Ensures the `session_id` field is properly populated from the event.
// ---------------------------------------------------------------------------

describe("coverage: session.compacted — line 53 (session_id population)", () => {
  it("populates session_id from session.compacted event properties", () => {
    const event: OpencodeEvent = {
      type: "session.compacted",
      properties: { sessionID: SESSION_ID },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("session_lifecycle");
    expect(msg!.metadata.subtype).toBe("session_compacted");
    expect(msg!.metadata.session_id).toBe(SESSION_ID);
  });

  it("session.compacted with a distinct session id value", () => {
    const distinctId = "sess-distinct-xyz";
    const event: OpencodeEvent = {
      type: "session.compacted",
      properties: { sessionID: distinctId },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.metadata.session_id).toBe(distinctId);
  });
});
