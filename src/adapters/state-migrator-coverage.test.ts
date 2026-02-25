/**
 * Coverage tests targeting uncovered branches in state-migrator.ts:
 *
 * Lines 17-18 — inside migrateV0ToV1:
 *   Line 17: `Array.isArray(session.pendingMessages) ? session.pendingMessages : []`
 *             The TRUE branch (pendingMessages IS already an array in a v0 session).
 *   Line 18: `Array.isArray(session.pendingPermissions) ? session.pendingPermissions : []`
 *             The TRUE branch (pendingPermissions IS already an array in a v0 session).
 *
 * Line 65 — `if (!migrate) return null;`
 *   The TRUE branch (no migration function registered for the current version).
 *   Exercised by spying on Map.prototype.get to return undefined for the
 *   version that would be looked up, simulating a gap in the migration chain.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateSession } from "./state-migrator.js";

describe("state-migrator — migrateV0ToV1 true branches (lines 17-18)", () => {
  it("preserves pendingMessages array when it already exists in a v0 session (line 17 true branch)", () => {
    const existingMsg = { type: "user_message", role: "user", content: [] };

    // v0 session that already has pendingMessages as an array.
    // migrateV0ToV1 sees Array.isArray(pendingMessages) === true → uses existing array.
    const v0WithPending = {
      id: "test-id",
      state: { session_id: "test-id" },
      messageHistory: [],
      pendingMessages: [existingMsg],
      // pendingPermissions absent → false branch (: []) on line 18
    };

    const result = migrateSession(v0WithPending);
    expect(result).not.toBeNull();
    // existingMsg is a plain object → survives the V1→V2 filter
    expect(result!.pendingMessages).toEqual([existingMsg]);
    expect(result!.schemaVersion).toBe(2);
  });

  it("preserves pendingPermissions array when it already exists in a v0 session (line 18 true branch)", () => {
    const existingPerm = { permissionId: "perm-1", tool: "bash" };

    // v0 session that already has pendingPermissions as an array.
    // migrateV0ToV1 sees Array.isArray(pendingPermissions) === true → uses existing array.
    const v0WithPermissions = {
      id: "test-id",
      state: { session_id: "test-id" },
      messageHistory: [],
      pendingPermissions: [existingPerm],
      // pendingMessages absent → false branch (: []) on line 17
    };

    const result = migrateSession(v0WithPermissions);
    expect(result).not.toBeNull();
    expect(result!.pendingPermissions).toEqual([existingPerm]);
    expect(result!.schemaVersion).toBe(2);
  });

  it("covers all three true branches when a v0 session has all optional fields as arrays", () => {
    const histMsg = { type: "user_message", role: "user" };
    const pendingMsg = { type: "user_message", role: "user", content: [] };
    const perm = { permissionId: "perm-2" };

    // All three fields are already arrays → all three true branches in migrateV0ToV1.
    const v0Full = {
      id: "test-id",
      state: { session_id: "test-id" },
      messageHistory: [histMsg], // TRUE branch line 16
      pendingMessages: [pendingMsg], // TRUE branch line 17
      pendingPermissions: [perm], // TRUE branch line 18
    };

    const result = migrateSession(v0Full);
    expect(result).not.toBeNull();
    expect(result!.messageHistory).toEqual([histMsg]);
    // pendingMsg is a plain object → survives V1→V2 filter
    expect(result!.pendingMessages).toEqual([pendingMsg]);
    expect(result!.pendingPermissions).toEqual([perm]);
    expect(result!.schemaVersion).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Line 28: false branch of ternary in migrateV1ToV2
// `const pending = Array.isArray(session.pendingMessages) ? session.pendingMessages : [];`
// Hit when a v1 session's pendingMessages is NOT an array (e.g. null or corrupt).
// ---------------------------------------------------------------------------

describe("state-migrator — migrateV1ToV2 false branch (line 28)", () => {
  it("defaults pendingMessages to [] when it is null/absent in a v1 session (line 28 false branch)", () => {
    // A v1 session with pendingMessages explicitly set to null (not an array).
    // migrateV1ToV2 sees Array.isArray(null) === false → uses [] as fallback.
    const v1WithNullPending = {
      id: "test-id",
      state: { session_id: "test-id" },
      messageHistory: [],
      pendingPermissions: [],
      pendingMessages: null, // not an array → false branch on line 28
      schemaVersion: 1,
    };

    const result = migrateSession(v1WithNullPending);
    expect(result).not.toBeNull();
    expect(result!.pendingMessages).toEqual([]);
    expect(result!.schemaVersion).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Line 65: `if (!migrate) return null;` — gap in migration chain
//
// The migrations Map in state-migrator.ts is a module-level const not exported.
// We spy on Map.prototype.get so that when migrateSession looks up a version
// during the migration loop it receives undefined, triggering the null return.
// ---------------------------------------------------------------------------

describe("state-migrator — gap in migration chain (line 65 true branch)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when migrations.get returns undefined (gap in migration chain, line 65)", () => {
    // Intercept all Map.prototype.get calls and return undefined to simulate
    // a missing migration entry.  We scope the spy to this test only and
    // restore it in afterEach.
    const origGet = Map.prototype.get;
    vi.spyOn(Map.prototype, "get").mockImplementation(function (
      this: Map<unknown, unknown>,
      key: unknown,
    ) {
      // Return undefined for numeric keys (migration version lookups) while
      // leaving other Map.get calls (e.g. internal vitest infrastructure) intact
      // by deferring to the original for non-Map<number,*> usages.
      if (typeof key === "number") {
        return undefined;
      }
      return origGet.call(this, key);
    });

    // A session at schemaVersion 0 (below CURRENT_SCHEMA_VERSION=2) would
    // normally migrate through v0→v1→v2.  With the spy returning undefined
    // for migrations.get(0), the `if (!migrate) return null` branch fires.
    const session = {
      id: "gap-test",
      state: { session_id: "gap-test" },
      // No schemaVersion → defaults to 0, so migration loop starts at version 0
    };

    expect(migrateSession(session)).toBeNull();
  });
});
