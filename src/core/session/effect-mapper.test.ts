import { describe, expect, it } from "vitest";
import { mapInboundCommandEffects, mapSetModelEffects } from "./effect-mapper.js";

describe("mapInboundCommandEffects — user_message", () => {
  it("returns error broadcast when lifecycle is closing", () => {
    const effects = mapInboundCommandEffects("user_message", {
      sessionId: "s1",
      lifecycle: "closing",
    });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: "BROADCAST", message: { type: "error" } });
  });

  it("returns error broadcast when lifecycle is closed", () => {
    const effects = mapInboundCommandEffects("user_message", {
      sessionId: "s1",
      lifecycle: "closed",
    });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: "BROADCAST", message: { type: "error" } });
  });

  it("returns empty effects on active lifecycle", () => {
    const effects = mapInboundCommandEffects("user_message", {
      sessionId: "s1",
      lifecycle: "active",
    });
    expect(effects).toHaveLength(0);
  });

  it("returns empty effects on idle lifecycle", () => {
    const effects = mapInboundCommandEffects("user_message", {
      sessionId: "s1",
      lifecycle: "idle",
    });
    expect(effects).toHaveLength(0);
  });
});

describe("mapInboundCommandEffects — set_adapter", () => {
  it("returns error broadcast regardless of lifecycle", () => {
    const effects = mapInboundCommandEffects("set_adapter", {
      sessionId: "s1",
      lifecycle: "active",
    });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: "BROADCAST", message: { type: "error" } });
  });
});

describe("mapInboundCommandEffects — unknown commands", () => {
  it("returns empty effects for set_model (handled elsewhere)", () => {
    expect(
      mapInboundCommandEffects("set_model", { sessionId: "s1", lifecycle: "active" }),
    ).toHaveLength(0);
  });

  it("returns empty effects for unrecognised command", () => {
    expect(
      mapInboundCommandEffects("totally_unknown", { sessionId: "s1", lifecycle: "active" }),
    ).toHaveLength(0);
  });
});

describe("mapSetModelEffects", () => {
  it("returns BROADCAST_SESSION_UPDATE with model patch", () => {
    const effects = mapSetModelEffects("claude-opus-4-6");
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      type: "BROADCAST_SESSION_UPDATE",
      patch: { model: "claude-opus-4-6" },
    });
  });
});
