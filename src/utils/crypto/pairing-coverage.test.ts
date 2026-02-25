/**
 * Coverage tests targeting previously uncovered branches in pairing.ts:
 *   - Line 97:  handlePairingRequest returns {success:false} when sealOpen succeeds
 *               but the decrypted payload is not 32 bytes.
 *   - Line 168: parsePairingLink throws when the decoded public key is not 32 bytes.
 */

import { describe, expect, it } from "vitest";
import { PairingManager, parsePairingLink } from "./pairing.js";
import { seal } from "./sealed-box.js";
import { getSodium } from "./sodium-loader.js";

describe("pairing — uncovered branch coverage", () => {
  /**
   * Line 97: peerPk.length !== 32
   *
   * sealOpen will successfully decrypt the ciphertext but the plaintext is only
   * 16 bytes, so the length guard fires and the method returns {success:false}.
   */
  it("handlePairingRequest returns false when decrypted payload is not 32 bytes", async () => {
    const manager = new PairingManager();
    await manager.generatePairingLink("https://tunnel.example.com");

    const daemonPk = manager.getKeypair()!.publicKey;

    // Seal a 16-byte (non-32-byte) plaintext so sealOpen succeeds but
    // the resulting peerPk fails the length === 32 check (line 97).
    const shortPayload = new Uint8Array(16).fill(0xab);
    const sealedShort = await seal(shortPayload, daemonPk);

    const result = await manager.handlePairingRequest(sealedShort);

    expect(result.success).toBe(false);
    expect(result.peerPublicKey).toBeUndefined();
  });

  /**
   * Line 168: publicKey.length !== 32
   *
   * Build a pairing URL whose `pk` parameter decodes to 16 bytes instead of 32.
   * parsePairingLink must throw the "public key must be 32 bytes" error.
   */
  it("parsePairingLink throws when public key decodes to wrong length", async () => {
    const sodium = await getSodium();

    // Encode a 16-byte value as base64url (URLSAFE_NO_PADDING)
    const shortKey = new Uint8Array(16).fill(0x42);
    const shortKeyB64 = sodium.to_base64(shortKey, sodium.base64_variants.URLSAFE_NO_PADDING);

    const url = `https://tunnel.example.com/pair?pk=${shortKeyB64}&fp=aabbccddeeff0011&v=1`;

    await expect(parsePairingLink(url)).rejects.toThrow(
      "Invalid pairing link: public key must be 32 bytes",
    );
  });
});
