import { describe, expect, it } from "vitest";
import { normalizeInbound } from "./inbound-normalizer.js";

describe("normalizeInbound", () => {
  it("normalizes user_message with text and session_id", () => {
    const result = normalizeInbound({
      type: "user_message",
      content: "hello",
      session_id: "cli-1",
    });

    expect(result).toBeDefined();
    expect(result!.type).toBe("user_message");
    expect(result!.role).toBe("user");
    expect(result!.metadata.session_id).toBe("cli-1");
    expect(result!.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("normalizes user_message with images first, then text", () => {
    const result = normalizeInbound({
      type: "user_message",
      content: "caption",
      images: [{ media_type: "image/png", data: "abc" }],
    });

    expect(result).toBeDefined();
    expect(result!.content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "abc" },
      },
      { type: "text", text: "caption" },
    ]);
  });

  it("normalizes permission_response with optional metadata fields", () => {
    const result = normalizeInbound({
      type: "permission_response",
      request_id: "perm-1",
      behavior: "allow",
      updated_input: { foo: "bar" },
      updated_permissions: [{ type: "setMode", mode: "plan" }],
      message: "ok",
    });

    expect(result).toBeDefined();
    expect(result!.type).toBe("permission_response");
    expect(result!.role).toBe("user");
    expect(result!.metadata).toEqual(
      expect.objectContaining({
        request_id: "perm-1",
        behavior: "allow",
        updated_input: { foo: "bar" },
        updated_permissions: [{ type: "setMode", mode: "plan" }],
        message: "ok",
      }),
    );
  });

  it("normalizes interrupt", () => {
    const result = normalizeInbound({ type: "interrupt" });
    expect(result).toBeDefined();
    expect(result).toEqual(
      expect.objectContaining({
        type: "interrupt",
        role: "user",
      }),
    );
  });

  it("normalizes set_model to configuration_change", () => {
    const result = normalizeInbound({ type: "set_model", model: "claude-opus" });
    expect(result).toBeDefined();
    expect(result!.type).toBe("configuration_change");
    expect(result!.metadata).toEqual(
      expect.objectContaining({
        subtype: "set_model",
        model: "claude-opus",
      }),
    );
  });

  it("normalizes set_permission_mode to configuration_change", () => {
    const result = normalizeInbound({ type: "set_permission_mode", mode: "plan" });
    expect(result).toBeDefined();
    expect(result!.type).toBe("configuration_change");
    expect(result!.metadata).toEqual(
      expect.objectContaining({
        subtype: "set_permission_mode",
        mode: "plan",
      }),
    );
  });

  it("returns null for presence_query and slash_command", () => {
    expect(normalizeInbound({ type: "presence_query" })).toBeNull();
    expect(normalizeInbound({ type: "slash_command", command: "/help" })).toBeNull();
  });

  it("returns null for unknown message types", () => {
    expect(normalizeInbound({ type: "unknown_type" } as any)).toBeNull();
  });
});
