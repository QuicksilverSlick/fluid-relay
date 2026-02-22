import { describe, expect, it } from "vitest";
import { RotatingTokenAuthority } from "./rotating-token-authority.js";

describe("RotatingTokenAuthority", () => {
  it("rotates and validates active tokens", () => {
    const authority = new RotatingTokenAuthority({ ttlMs: 60_000 });
    const { token } = authority.rotate();

    expect(authority.currentToken()).toBe(token);
    expect(authority.validate(token)).toBe(true);
  });

  it("rejects tokens after TTL expiry", () => {
    let now = 1_000;
    const authority = new RotatingTokenAuthority({
      ttlMs: 100,
      now: () => now,
    });

    const { token } = authority.rotate();
    expect(authority.validate(token)).toBe(true);

    now = 1_101;
    expect(authority.validate(token)).toBe(false);
  });

  it("keeps previous tokens valid until they expire", () => {
    let now = 1_000;
    const authority = new RotatingTokenAuthority({
      ttlMs: 1_000,
      maxActiveTokens: 4,
      now: () => now,
    });

    const first = authority.rotate().token;
    now = 1_100;
    const second = authority.rotate().token;

    expect(authority.validate(first)).toBe(true);
    expect(authority.validate(second)).toBe(true);

    now = 2_001;
    expect(authority.validate(first)).toBe(false);
    expect(authority.validate(second)).toBe(true);
  });

  it("revokeAll invalidates all tokens immediately", () => {
    const authority = new RotatingTokenAuthority({ ttlMs: 60_000 });
    const one = authority.rotate().token;
    const two = authority.rotate().token;

    authority.revokeAll();

    expect(authority.currentToken()).toBeNull();
    expect(authority.validate(one)).toBe(false);
    expect(authority.validate(two)).toBe(false);
  });

  it("enforces max active token window", () => {
    const authority = new RotatingTokenAuthority({
      ttlMs: 60_000,
      maxActiveTokens: 2,
    });

    const one = authority.rotate().token;
    const two = authority.rotate().token;
    const three = authority.rotate().token;

    expect(authority.validate(one)).toBe(false);
    expect(authority.validate(two)).toBe(true);
    expect(authority.validate(three)).toBe(true);
  });
});
