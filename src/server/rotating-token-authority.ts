import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

type TokenRecord = {
  hash: Buffer;
  expiresAt: number;
};

export interface RotatingTokenAuthorityOptions {
  ttlMs: number;
  maxActiveTokens?: number;
  now?: () => number;
}

export class RotatingTokenAuthority {
  private readonly ttlMs: number;
  private readonly maxActiveTokens: number;
  private readonly now: () => number;
  private readonly tokens: TokenRecord[] = [];
  private currentTokenValue: string | null = null;

  constructor(options: RotatingTokenAuthorityOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error("RotatingTokenAuthority requires a positive ttlMs");
    }
    this.ttlMs = options.ttlMs;
    this.maxActiveTokens = options.maxActiveTokens ?? 6;
    this.now = options.now ?? (() => Date.now());
  }

  rotate(): { token: string; expiresAt: number } {
    this.pruneExpired();

    const token = randomBytes(24).toString("base64url");
    const record: TokenRecord = {
      hash: createHash("sha256").update(token).digest(),
      expiresAt: this.now() + this.ttlMs,
    };

    this.tokens.push(record);
    if (this.tokens.length > this.maxActiveTokens) {
      this.tokens.splice(0, this.tokens.length - this.maxActiveTokens);
    }
    this.currentTokenValue = token;
    return { token, expiresAt: record.expiresAt };
  }

  currentToken(): string | null {
    return this.currentTokenValue;
  }

  validate(token: string): boolean {
    if (!token) return false;
    this.pruneExpired();
    if (this.tokens.length === 0) return false;

    const providedHash = createHash("sha256").update(token).digest();
    for (const entry of this.tokens) {
      if (timingSafeEqual(entry.hash, providedHash)) {
        return true;
      }
    }
    return false;
  }

  revokeAll(): void {
    this.tokens.length = 0;
    this.currentTokenValue = null;
  }

  private pruneExpired(): void {
    const now = this.now();
    const active = this.tokens.filter((entry) => entry.expiresAt > now);
    if (active.length !== this.tokens.length) {
      this.tokens.length = 0;
      this.tokens.push(...active);
      if (this.tokens.length === 0) {
        this.currentTokenValue = null;
      }
    }
  }
}
