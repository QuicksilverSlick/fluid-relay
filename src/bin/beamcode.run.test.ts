import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const daemonStart = vi.fn(async () => {});
  const daemonStop = vi.fn(async () => {});

  const cloudflaredStart = vi.fn(async () => ({ url: "https://beam.example" }));
  const cloudflaredStop = vi.fn(async () => {});

  const coordinatorStart = vi.fn(async () => {});
  const coordinatorStop = vi.fn(async () => {});
  const coordinatorCreateSession = vi.fn(async () => ({ sessionId: "session-1" }));
  const coordinatorSetServer = vi.fn();
  const coordinatorOn = vi.fn();
  const coordinatorListSessions = vi.fn(() => []);
  const coordinatorInstances: Array<{
    setServer: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    registry: { listSessions: ReturnType<typeof vi.fn> };
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    createSession: ReturnType<typeof vi.fn>;
  }> = [];

  const wsServerInstances: Array<Record<string, unknown>> = [];
  const apiAuthenticatorArgs: unknown[] = [];
  const tracerConfigs: Array<{ level: string; allowSensitive: boolean }> = [];

  const loadConsumerHtml = vi.fn();
  const injectConsumerAuthTokens = vi.fn();

  const createBeamcodeServer = vi.fn(() => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    return {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners.set(event, cb);
        return undefined;
      }),
      listen: vi.fn((_port: number, cb: () => void) => cb()),
      setActiveSessionId: vi.fn(),
      close: vi.fn((cb: () => void) => cb()),
      listeners,
    };
  });

  const adapterResolve = vi.fn(() => ({ name: "codex" }));
  const createAdapterResolver = vi.fn(() => ({
    defaultName: "codex",
    resolve: adapterResolve,
  }));

  const loggerInfo = vi.fn();
  const loggerWarn = vi.fn();
  const loggerError = vi.fn();

  class MockDaemon {
    start = daemonStart;
    stop = daemonStop;
  }

  class MockCloudflaredManager {
    start = cloudflaredStart;
    stop = cloudflaredStop;
  }

  class MockSessionCoordinator {
    setServer = coordinatorSetServer;
    on = coordinatorOn;
    registry = { listSessions: coordinatorListSessions };
    start = coordinatorStart;
    stop = coordinatorStop;
    createSession = coordinatorCreateSession;

    constructor(_opts: unknown) {
      coordinatorInstances.push(this);
    }
  }

  class MockNodeWebSocketServer {
    constructor(opts: Record<string, unknown>) {
      wsServerInstances.push(opts);
    }
  }

  class MockApiKeyAuthenticator {
    constructor(arg: unknown) {
      apiAuthenticatorArgs.push(arg);
    }
  }

  class MockMessageTracerImpl {
    constructor(config: { level: string; allowSensitive: boolean }) {
      tracerConfigs.push(config);
    }
  }

  class MockStructuredLogger {
    info = loggerInfo;
    warn = loggerWarn;
    error = loggerError;
    constructor(_opts: unknown) {}
  }

  return {
    daemonStart,
    daemonStop,
    cloudflaredStart,
    cloudflaredStop,
    coordinatorStart,
    coordinatorStop,
    coordinatorCreateSession,
    coordinatorSetServer,
    coordinatorOn,
    coordinatorListSessions,
    coordinatorInstances,
    wsServerInstances,
    apiAuthenticatorArgs,
    tracerConfigs,
    loadConsumerHtml,
    injectConsumerAuthTokens,
    createBeamcodeServer,
    createAdapterResolver,
    adapterResolve,
    loggerInfo,
    loggerWarn,
    loggerError,
    MockDaemon,
    MockCloudflaredManager,
    MockSessionCoordinator,
    MockNodeWebSocketServer,
    MockApiKeyAuthenticator,
    MockMessageTracerImpl,
    MockStructuredLogger,
  };
});

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomBytes: vi.fn(() => ({
      toString: () => "token-123",
    })),
  };
});

vi.mock("../adapters/adapter-resolver.js", () => ({
  createAdapterResolver: harness.createAdapterResolver,
}));
vi.mock("../adapters/claude/claude-launcher.js", () => ({
  ClaudeLauncher: class {
    constructor(_opts: unknown) {}
  },
}));
vi.mock("../adapters/composite-metrics-collector.js", () => ({
  CompositeMetricsCollector: class {
    constructor(_collectors: unknown[]) {}
  },
}));
vi.mock("../adapters/console-metrics-collector.js", () => ({
  ConsoleMetricsCollector: class {
    constructor(_logger: unknown, _errorAggregator: unknown) {}
  },
}));
vi.mock("../adapters/default-git-resolver.js", () => ({
  DefaultGitResolver: class {},
}));
vi.mock("../adapters/error-aggregator.js", () => ({
  ErrorAggregator: class {},
}));
vi.mock("../adapters/file-storage.js", () => ({
  FileStorage: class {
    constructor(_dir: string) {}
  },
}));
vi.mock("../adapters/node-process-manager.js", () => ({
  NodeProcessManager: class {},
}));
vi.mock("../adapters/node-ws-server.js", () => ({
  NodeWebSocketServer: harness.MockNodeWebSocketServer,
}));
vi.mock("../adapters/structured-logger.js", () => ({
  LogLevel: { DEBUG: "debug", INFO: "info" },
  StructuredLogger: harness.MockStructuredLogger,
}));
vi.mock("../adapters/token-bucket-limiter.js", () => ({
  TokenBucketLimiter: class {
    constructor(_burstSize: number, _refillIntervalMs: number, _tokensPerInterval: number) {}
  },
}));
vi.mock("../core/messaging/message-tracer.js", () => ({
  MessageTracerImpl: harness.MockMessageTracerImpl,
  noopTracer: { kind: "noop" },
}));
vi.mock("../core/session-coordinator.js", () => ({
  SessionCoordinator: harness.MockSessionCoordinator,
}));
vi.mock("../daemon/daemon.js", () => ({
  Daemon: harness.MockDaemon,
}));
vi.mock("../http/consumer-html.js", () => ({
  injectConsumerAuthTokens: harness.injectConsumerAuthTokens,
  loadConsumerHtml: harness.loadConsumerHtml,
}));
vi.mock("../http/server.js", () => ({
  createBeamcodeServer: harness.createBeamcodeServer,
}));
vi.mock("../relay/cloudflared-manager.js", () => ({
  CloudflaredManager: harness.MockCloudflaredManager,
}));
vi.mock("../server/api-key-authenticator.js", () => ({
  ApiKeyAuthenticator: harness.MockApiKeyAuthenticator,
}));
vi.mock("../server/origin-validator.js", () => ({
  OriginValidator: class {},
}));
vi.mock("../utils/resolve-package-version.js", () => ({
  resolvePackageVersion: vi.fn(() => "test-version"),
}));

import { runBeamcode } from "./beamcode.js";

describe("runBeamcode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.coordinatorInstances.length = 0;
    harness.wsServerInstances.length = 0;
    harness.apiAuthenticatorArgs.length = 0;
    harness.tracerConfigs.length = 0;
    harness.cloudflaredStart.mockResolvedValue({ url: "https://beam.example" });
    harness.coordinatorCreateSession.mockResolvedValue({ sessionId: "session-1" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts without tunnel and without auto-launch", async () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation((() => process) as any);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runBeamcode(["node", "beamcode", "--no-tunnel", "--no-auto-launch"]);

    expect(harness.loadConsumerHtml).toHaveBeenCalledOnce();
    expect(harness.injectConsumerAuthTokens).toHaveBeenCalledWith({
      apiToken: "token-123",
      consumerToken: "token-123",
    });
    expect(harness.daemonStart).toHaveBeenCalledOnce();
    expect(harness.cloudflaredStart).not.toHaveBeenCalled();
    expect(harness.coordinatorCreateSession).not.toHaveBeenCalled();
    expect(harness.apiAuthenticatorArgs).toHaveLength(0);
    expect(harness.createBeamcodeServer).toHaveBeenCalledOnce();
    const server = harness.createBeamcodeServer.mock.results[0]?.value as {
      setActiveSessionId: ReturnType<typeof vi.fn>;
    };
    expect(server.setActiveSessionId).toHaveBeenCalledWith("");
    expect(onSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(logSpy).toHaveBeenCalled();
  });

  it("starts tunnel and auto-launches a session with trace enabled", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runBeamcode([
      "node",
      "beamcode",
      "--trace",
      "--trace-level",
      "full",
      "--trace-allow-sensitive",
    ]);

    expect(harness.cloudflaredStart).toHaveBeenCalledOnce();
    expect(harness.coordinatorCreateSession).toHaveBeenCalledOnce();
    expect(harness.apiAuthenticatorArgs).toHaveLength(1);
    expect(typeof harness.apiAuthenticatorArgs[0]).toBe("function");
    expect(harness.tracerConfigs).toEqual([{ level: "full", allowSensitive: true }]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Message tracing enabled (level=full)"),
    );
    const server = harness.createBeamcodeServer.mock.results[0]?.value as {
      setActiveSessionId: ReturnType<typeof vi.fn>;
    };
    expect(server.setActiveSessionId).toHaveBeenCalledWith("session-1");
  });

  it("exits with error when daemon reports an existing running instance", async () => {
    harness.daemonStart.mockRejectedValueOnce(new Error("already running"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`EXIT:${String(code)}`);
    });

    await expect(runBeamcode(["node", "beamcode"])).rejects.toThrow("EXIT:1");
    expect(errorSpy).toHaveBeenCalledWith(
      "Stop the other instance first, or use a different --data-dir.",
    );
    expect(harness.cloudflaredStart).not.toHaveBeenCalled();
  });

  it("continues startup when cloudflared is missing from PATH", async () => {
    harness.cloudflaredStart.mockRejectedValueOnce(new Error("cloudflared not found in PATH"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runBeamcode(["node", "beamcode", "--no-auto-launch"]);

    expect(harness.cloudflaredStart).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Continuing without tunnel"));
    expect(harness.coordinatorStart).toHaveBeenCalledOnce();
  });
});
