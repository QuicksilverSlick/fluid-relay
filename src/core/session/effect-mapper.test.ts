import { describe, expect, it } from "vitest";
import { mapInboundCommandEffects } from "./effect-mapper.js";

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
  it("returns empty effects for set_model (handled by reducer)", () => {
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
