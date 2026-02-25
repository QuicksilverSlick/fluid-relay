import { describe, expect, it, vi } from "vitest";
import { createMockSession, noopLogger } from "../../testing/cli-message-factories.js";
import { DEFAULT_CONFIG } from "../../types/config.js";
import { CapabilitiesPolicy } from "./capabilities-policy.js";

describe("CapabilitiesPolicy", () => {
  it("dispatches CAPABILITIES_INIT_REQUESTED signal via runtime process", () => {
    const process = vi.fn();
    const policy = new CapabilitiesPolicy(DEFAULT_CONFIG, noopLogger, (_session: any) => ({
      process,
    }));

    const session = createMockSession();
    policy.sendInitializeRequest(session);

    expect(process).toHaveBeenCalledWith({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "CAPABILITIES_INIT_REQUESTED" },
    });
  });
});
