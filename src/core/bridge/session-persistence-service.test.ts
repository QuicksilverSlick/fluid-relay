import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../interfaces/logger.js";
import type { SessionRepository } from "../session-repository.js";
import { SessionPersistenceService } from "./session-persistence-service.js";

function createService() {
  const store = {
    restoreAll: vi.fn().mockReturnValue(0),
    persist: vi.fn(),
    getStorage: vi.fn().mockReturnValue(null),
  } as unknown as SessionRepository;

  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const service = new SessionPersistenceService({ store, logger });
  return { service, store, logger };
}

describe("SessionPersistenceService", () => {
  it("restoreFromStorage returns store count", () => {
    const { service, store } = createService();
    vi.mocked(store.restoreAll).mockReturnValue(2);
    expect(service.restoreFromStorage()).toBe(2);
    expect(store.restoreAll).toHaveBeenCalled();
  });

  it("logs restore message only when count is greater than zero", () => {
    const first = createService();
    vi.mocked(first.store.restoreAll).mockReturnValue(3);
    first.service.restoreFromStorage();
    expect(first.logger.info).toHaveBeenCalledWith("Restored 3 session(s) from disk");

    const second = createService();
    vi.mocked(second.store.restoreAll).mockReturnValue(0);
    second.service.restoreFromStorage();
    expect(second.logger.info).not.toHaveBeenCalled();
  });

  it("persist delegates to store.persist", () => {
    const { service, store } = createService();
    const session = { id: "s1" } as any;
    service.persist(session);
    expect(store.persist).toHaveBeenCalledWith(session);
  });

  it("getStorage delegates to store.getStorage", () => {
    const { service, store } = createService();
    const marker = {} as any;
    vi.mocked(store.getStorage).mockReturnValue(marker);
    expect(service.getStorage()).toBe(marker);
  });
});
