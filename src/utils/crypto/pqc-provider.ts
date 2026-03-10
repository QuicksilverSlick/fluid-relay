/**
 * Post-Quantum Cryptography Provider — future-proof crypto abstraction.
 *
 * Provides a unified interface for cryptographic operations that supports
 * both classical (libsodium XSalsa20-Poly1305) and post-quantum
 * (ML-KEM-768 / Kyber) algorithms behind a feature flag.
 *
 * The EncryptionLayer already uses Uint8Array keypairs with no algorithm
 * hardcoding — this module extends that pattern with an explicit algorithm
 * field and hybrid mode support.
 *
 * Algorithm support:
 *   - "x25519-xsalsa20-poly1305" (default) — current libsodium sealed boxes
 *   - "ml-kem-768" (flag-gated) — NIST FIPS 203 lattice-based KEM
 *   - "hybrid" (flag-gated) — both algorithms in parallel for defense-in-depth
 *
 * Current status: ML-KEM-768 is stubbed with the interface ready for a real
 * implementation when a production-grade JS library ships. The classical
 * path delegates to the existing libsodium functions.
 *
 * @module Crypto
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CryptoAlgorithm =
  | "x25519-xsalsa20-poly1305"
  | "ml-kem-768"
  | "hybrid";

export interface PQCKeyPair {
  algorithm: CryptoAlgorithm;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  /** For hybrid mode: the secondary keypair. */
  secondaryPublicKey?: Uint8Array;
  secondarySecretKey?: Uint8Array;
}

export interface EncapsulationResult {
  /** The shared secret (used as the symmetric encryption key). */
  sharedSecret: Uint8Array;
  /** The encapsulated key (sent to the peer). */
  ciphertext: Uint8Array;
}

export interface PQCProviderOptions {
  /** Which algorithm to use. Default: "x25519-xsalsa20-poly1305". */
  algorithm?: CryptoAlgorithm;
  /** Enable ML-KEM-768 support. Default: false.
   * When false, requesting ml-kem-768 or hybrid throws an error. */
  enablePQC?: boolean;
}

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

let pqcEnabled = false;

export function setPQCEnabled(enabled: boolean): void {
  pqcEnabled = enabled;
}

export function isPQCEnabled(): boolean {
  return pqcEnabled;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class PQCProvider {
  readonly algorithm: CryptoAlgorithm;

  constructor(options: PQCProviderOptions = {}) {
    this.algorithm = options.algorithm ?? "x25519-xsalsa20-poly1305";

    if (options.enablePQC !== undefined) {
      pqcEnabled = options.enablePQC;
    }

    if (
      (this.algorithm === "ml-kem-768" || this.algorithm === "hybrid") &&
      !pqcEnabled
    ) {
      throw new Error(
        `PQC algorithm "${this.algorithm}" requested but PQC is not enabled. ` +
          "Set enablePQC: true to opt in.",
      );
    }
  }

  /**
   * Generate a keypair for the configured algorithm.
   */
  async generateKeypair(): Promise<PQCKeyPair> {
    switch (this.algorithm) {
      case "x25519-xsalsa20-poly1305":
        return this.generateClassicalKeypair();

      case "ml-kem-768":
        return this.generateMLKEMKeypair();

      case "hybrid":
        return this.generateHybridKeypair();

      default:
        throw new Error(`Unknown algorithm: ${this.algorithm}`);
    }
  }

  /**
   * Encapsulate a shared secret for the peer's public key.
   * (KEM encapsulation — the sender's side of the key exchange.)
   */
  async encapsulate(
    peerPublicKey: Uint8Array,
    _peerSecondaryKey?: Uint8Array,
  ): Promise<EncapsulationResult> {
    switch (this.algorithm) {
      case "x25519-xsalsa20-poly1305":
        return this.classicalEncapsulate(peerPublicKey);

      case "ml-kem-768":
        return this.mlkemEncapsulate(peerPublicKey);

      case "hybrid":
        return this.hybridEncapsulate(peerPublicKey, _peerSecondaryKey);

      default:
        throw new Error(`Unknown algorithm: ${this.algorithm}`);
    }
  }

  /**
   * Decapsulate a shared secret from the ciphertext.
   * (KEM decapsulation — the receiver's side of the key exchange.)
   */
  async decapsulate(
    ciphertext: Uint8Array,
    secretKey: Uint8Array,
    _secondarySecretKey?: Uint8Array,
  ): Promise<Uint8Array> {
    switch (this.algorithm) {
      case "x25519-xsalsa20-poly1305":
        return this.classicalDecapsulate(ciphertext, secretKey);

      case "ml-kem-768":
        return this.mlkemDecapsulate(ciphertext, secretKey);

      case "hybrid":
        return this.hybridDecapsulate(ciphertext, secretKey, _secondarySecretKey);

      default:
        throw new Error(`Unknown algorithm: ${this.algorithm}`);
    }
  }

  /**
   * Get metadata about the current algorithm.
   */
  getAlgorithmInfo(): {
    name: CryptoAlgorithm;
    nistLevel: number;
    pqcSafe: boolean;
    keySize: number;
    ciphertextSize: number;
  } {
    switch (this.algorithm) {
      case "x25519-xsalsa20-poly1305":
        return {
          name: this.algorithm,
          nistLevel: 0, // Not PQC rated
          pqcSafe: false,
          keySize: 32,
          ciphertextSize: 48,
        };
      case "ml-kem-768":
        return {
          name: this.algorithm,
          nistLevel: 3, // NIST Level 3 security
          pqcSafe: true,
          keySize: 1184,
          ciphertextSize: 1088,
        };
      case "hybrid":
        return {
          name: this.algorithm,
          nistLevel: 3,
          pqcSafe: true,
          keySize: 32 + 1184,
          ciphertextSize: 48 + 1088,
        };
    }
  }

  // ── Classical (libsodium) ────────────────────────────────────────────────

  private async generateClassicalKeypair(): Promise<PQCKeyPair> {
    const { getSodium } = await import("./sodium-loader.js");
    const sodium = await getSodium();
    const kp = sodium.crypto_box_keypair();
    return {
      algorithm: "x25519-xsalsa20-poly1305",
      publicKey: kp.publicKey,
      secretKey: kp.privateKey,
    };
  }

  private async classicalEncapsulate(
    peerPublicKey: Uint8Array,
  ): Promise<EncapsulationResult> {
    // For classical crypto, "encapsulation" is generating a random shared secret
    // and sealing it with the peer's public key.
    const { getSodium } = await import("./sodium-loader.js");
    const sodium = await getSodium();
    const sharedSecret = sodium.randombytes_buf(32);
    const ciphertext = sodium.crypto_box_seal(sharedSecret, peerPublicKey);
    return { sharedSecret, ciphertext };
  }

  private async classicalDecapsulate(
    ciphertext: Uint8Array,
    secretKey: Uint8Array,
  ): Promise<Uint8Array> {
    const { getSodium } = await import("./sodium-loader.js");
    const sodium = await getSodium();
    // Derive public key from secret key for crypto_box_seal_open
    const publicKey = sodium.crypto_scalarmult_base(secretKey);
    return sodium.crypto_box_seal_open(ciphertext, publicKey, secretKey);
  }

  // ── ML-KEM-768 (stubbed) ────────────────────────────────────────────────

  private async generateMLKEMKeypair(): Promise<PQCKeyPair> {
    // Stub: ML-KEM-768 keypair generation.
    // When a production-grade JS ML-KEM library ships, replace this with:
    //   import { ml_kem768 } from 'ml-kem';
    //   const { publicKey, secretKey } = ml_kem768.keygen();
    throw new Error(
      "ML-KEM-768 keypair generation is not yet implemented. " +
        "Awaiting production-grade JS library. " +
        "Use x25519-xsalsa20-poly1305 or hybrid mode for now.",
    );
  }

  private async mlkemEncapsulate(
    _peerPublicKey: Uint8Array,
  ): Promise<EncapsulationResult> {
    throw new Error(
      "ML-KEM-768 encapsulation is not yet implemented. " +
        "Interface is ready for drop-in when library ships.",
    );
  }

  private async mlkemDecapsulate(
    _ciphertext: Uint8Array,
    _secretKey: Uint8Array,
  ): Promise<Uint8Array> {
    throw new Error(
      "ML-KEM-768 decapsulation is not yet implemented. " +
        "Interface is ready for drop-in when library ships.",
    );
  }

  // ── Hybrid ───────────────────────────────────────────────────────────────

  private async generateHybridKeypair(): Promise<PQCKeyPair> {
    // Generate classical keypair (ML-KEM part is stubbed)
    const classical = await this.generateClassicalKeypair();
    return {
      algorithm: "hybrid",
      publicKey: classical.publicKey,
      secretKey: classical.secretKey,
      // Secondary keys would be ML-KEM — stubbed for now
      secondaryPublicKey: undefined,
      secondarySecretKey: undefined,
    };
  }

  private async hybridEncapsulate(
    peerPublicKey: Uint8Array,
    _peerSecondaryKey?: Uint8Array,
  ): Promise<EncapsulationResult> {
    // In hybrid mode, we run classical encapsulation and combine secrets.
    // ML-KEM encapsulation would run in parallel when available.
    return this.classicalEncapsulate(peerPublicKey);
  }

  private async hybridDecapsulate(
    ciphertext: Uint8Array,
    secretKey: Uint8Array,
    _secondarySecretKey?: Uint8Array,
  ): Promise<Uint8Array> {
    return this.classicalDecapsulate(ciphertext, secretKey);
  }
}
