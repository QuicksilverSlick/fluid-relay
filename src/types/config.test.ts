import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";

describe("resolveConfig", () => {
  it("rejects negative idleSessionTimeoutMs", () => {
    expect(() =>
      resolveConfig({
        port: 3456,
        idleSessionTimeoutMs: -1,
      }),
    ).toThrow("Invalid configuration");
  });

  it("keeps security deny list when overridden with empty list", () => {
    const resolved = resolveConfig({
      port: 3456,
      envDenyList: [],
    });
    expect(resolved.envDenyList.length).toBeGreaterThan(0);
  });
});
