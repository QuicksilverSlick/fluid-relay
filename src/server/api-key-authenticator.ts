import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthContext, Authenticator, ConsumerIdentity } from "../interfaces/auth.js";

type TokenValidator = (token: string) => boolean | Promise<boolean>;

/**
 * Authenticator that validates a scoped consumer token from WebSocket query params.
 * Used to enforce authentication on consumer connections when a tunnel is active,
 * since tunnel-forwarded requests bypass bind-address and origin checks.
 *
 * Consumers connect with `?token=<consumerToken>` on the WebSocket URL.
 */
export class ApiKeyAuthenticator implements Authenticator {
  private readonly keyHash: Buffer | null;
  private readonly validator: TokenValidator | null;

  constructor(apiKeyOrValidator: string | TokenValidator) {
    if (typeof apiKeyOrValidator === "string") {
      this.keyHash = createHash("sha256").update(apiKeyOrValidator).digest();
      this.validator = null;
      return;
    }
    this.keyHash = null;
    this.validator = apiKeyOrValidator;
  }

  async authenticate(context: AuthContext): Promise<ConsumerIdentity> {
    const query = context.transport.query;
    if (!query || typeof query !== "object") {
      throw new Error("Authentication required: missing token query parameter");
    }

    const token = (query as Record<string, unknown>).token;
    if (typeof token !== "string" || !token) {
      throw new Error("Authentication required: missing token query parameter");
    }

    let isValid = false;
    if (this.validator) {
      isValid = await this.validator(token);
    } else if (this.keyHash) {
      isValid = timingSafeEqual(createHash("sha256").update(token).digest(), this.keyHash);
    }
    if (!isValid) {
      throw new Error("Authentication failed: invalid token");
    }

    return {
      userId: "api-key-user",
      displayName: "Authenticated User",
      role: "participant",
    };
  }
}
