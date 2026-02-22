import { describe, expect, it } from "vitest";
import { InMemorySessionLeaseCoordinator } from "./session-lease-coordinator.js";

describe("InMemorySessionLeaseCoordinator", () => {
  it("acquires lease when unowned and allows same owner re-acquire", () => {
    const leases = new InMemorySessionLeaseCoordinator();

    expect(leases.ensureLease("s1", "owner-a")).toBe(true);
    expect(leases.ensureLease("s1", "owner-a")).toBe(true);
    expect(leases.hasLease("s1", "owner-a")).toBe(true);
    expect(leases.currentOwner("s1")).toBe("owner-a");
  });

  it("rejects acquisition by a different owner", () => {
    const leases = new InMemorySessionLeaseCoordinator();
    leases.ensureLease("s1", "owner-a");

    expect(leases.ensureLease("s1", "owner-b")).toBe(false);
    expect(leases.hasLease("s1", "owner-b")).toBe(false);
    expect(leases.currentOwner("s1")).toBe("owner-a");
  });

  it("releases only when owner matches", () => {
    const leases = new InMemorySessionLeaseCoordinator();
    leases.ensureLease("s1", "owner-a");

    leases.releaseLease("s1", "owner-b");
    expect(leases.currentOwner("s1")).toBe("owner-a");

    leases.releaseLease("s1", "owner-a");
    expect(leases.currentOwner("s1")).toBeNull();
  });
});
