/**
 * Session lease coordination contract.
 *
 * The default implementation is process-local and intentionally simple.
 * It creates a seam for future distributed lease backends (Redis/DB).
 */
export interface SessionLeaseCoordinator {
  /**
   * Ensure `ownerId` holds the lease for `sessionId`.
   * Returns true when lease is acquired or already owned by `ownerId`.
   */
  ensureLease(sessionId: string, ownerId: string): boolean;
  /** Returns true when `ownerId` currently owns the lease. */
  hasLease(sessionId: string, ownerId: string): boolean;
  /** Release the lease if owned by `ownerId`. */
  releaseLease(sessionId: string, ownerId: string): void;
  /** Best-effort owner lookup for logging/diagnostics. */
  currentOwner(sessionId: string): string | null;
}

/**
 * In-memory lease coordinator scoped to a single process.
 * This does NOT provide cross-process coordination.
 */
export class InMemorySessionLeaseCoordinator implements SessionLeaseCoordinator {
  private readonly leases = new Map<string, string>();

  ensureLease(sessionId: string, ownerId: string): boolean {
    const current = this.leases.get(sessionId);
    if (!current) {
      this.leases.set(sessionId, ownerId);
      return true;
    }
    return current === ownerId;
  }

  hasLease(sessionId: string, ownerId: string): boolean {
    return this.leases.get(sessionId) === ownerId;
  }

  releaseLease(sessionId: string, ownerId: string): void {
    if (this.leases.get(sessionId) === ownerId) {
      this.leases.delete(sessionId);
    }
  }

  currentOwner(sessionId: string): string | null {
    return this.leases.get(sessionId) ?? null;
  }
}
