import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createShutdownHandler,
  isCliEntrypoint,
  parseArgs,
  type ShutdownHandlerDeps,
} from "./beamcode.js";

function expectExitCode(fn: () => unknown, code: number): void {
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error(`EXIT:${code}`);
  }) as any);
  expect(fn).toThrow(`EXIT:${code}`);
  expect(exitSpy).toHaveBeenCalledWith(code);
}

describe("beamcode entrypoint helpers", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv, HOME: "/test-home" };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("parseArgs", () => {
    it("returns defaults with no flags", () => {
      const config = parseArgs(["node", "beamcode"]);

      expect(config).toEqual({
        port: 9414,
        noTunnel: false,
        noAutoLaunch: false,
        dataDir: join("/test-home", ".beamcode"),
        cwd: process.cwd(),
        claudeBinary: "claude",
        verbose: false,
        trace: false,
        traceLevel: "smart",
        traceAllowSensitive: false,
      });
    });

    it("parses CLI flags", () => {
      const config = parseArgs([
        "node",
        "beamcode",
        "--port",
        "19000",
        "--no-tunnel",
        "--tunnel-token",
        "token-123",
        "--data-dir",
        "/tmp/beamcode",
        "--model",
        "sonnet",
        "--cwd",
        "/repo",
        "--claude-binary",
        "/usr/local/bin/claude",
        "--adapter",
        "codex",
        "--no-auto-launch",
        "--trace",
        "--trace-level",
        "headers",
        "--trace-allow-sensitive",
        "--prometheus",
        "--verbose",
      ]);

      expect(config).toMatchObject({
        port: 19000,
        noTunnel: true,
        noAutoLaunch: true,
        tunnelToken: "token-123",
        dataDir: "/tmp/beamcode",
        model: "sonnet",
        cwd: "/repo",
        claudeBinary: "/usr/local/bin/claude",
        verbose: true,
        adapter: "codex",
        trace: true,
        traceLevel: "headers",
        traceAllowSensitive: true,
        prometheus: true,
      });
    });

    it("uses environment defaults when explicit flags are absent", () => {
      process.env.BEAMCODE_ADAPTER = "acp";
      process.env.BEAMCODE_NO_AUTO_LAUNCH = "1";
      process.env.BEAMCODE_TRACE = "1";
      process.env.BEAMCODE_TRACE_LEVEL = "headers";
      process.env.BEAMCODE_TRACE_ALLOW_SENSITIVE = "true";

      const config = parseArgs(["node", "beamcode"]);

      expect(config.adapter).toBe("acp");
      expect(config.noAutoLaunch).toBe(true);
      expect(config.trace).toBe(true);
      expect(config.traceLevel).toBe("headers");
      expect(config.traceAllowSensitive).toBe(true);
    });

    it("gives CLI adapter precedence over BEAMCODE_ADAPTER", () => {
      process.env.BEAMCODE_ADAPTER = "acp";
      const config = parseArgs(["node", "beamcode", "--adapter", "codex"]);
      expect(config.adapter).toBe("codex");
    });

    it("errors on invalid --port", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expectExitCode(() => parseArgs(["node", "beamcode", "--port", "bad"]), 1);
      expect(errorSpy).toHaveBeenCalledWith("Error: --port requires a number");
    });

    it("errors on invalid adapter from environment", () => {
      process.env.BEAMCODE_ADAPTER = "invalid";
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expectExitCode(() => parseArgs(["node", "beamcode"]), 1);
      expect(errorSpy).toHaveBeenCalledOnce();
      expect(errorSpy.mock.calls[0]?.[0]).toContain("Error: BEAMCODE_ADAPTER must be one of:");
    });

    it("errors when trace level is full without allow-sensitive", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expectExitCode(() => parseArgs(["node", "beamcode", "--trace", "--trace-level", "full"]), 1);
      expect(errorSpy).toHaveBeenCalledWith(
        "Error: --trace-level full requires --trace-allow-sensitive",
      );
    });

    it("warns when trace-level is set without trace", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const config = parseArgs(["node", "beamcode", "--trace-level", "headers"]);

      expect(config.trace).toBe(false);
      expect(config.traceLevel).toBe("headers");
      expect(warnSpy).toHaveBeenCalledWith(
        "Warning: --trace-level and --trace-allow-sensitive have no effect without --trace",
      );
    });

    it("errors on unknown options", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expectExitCode(() => parseArgs(["node", "beamcode", "--wat"]), 1);
      expect(errorSpy).toHaveBeenCalledWith("Unknown option: --wat\nRun with --help for usage.");
    });

    it("prints help and exits 0", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      expectExitCode(() => parseArgs(["node", "beamcode", "--help"]), 0);
      expect(logSpy).toHaveBeenCalledOnce();
    });
  });

  describe("createShutdownHandler", () => {
    function buildDeps(overrides: Partial<ShutdownHandlerDeps> = {}): {
      deps: ShutdownHandlerDeps;
      calls: string[];
      onExit: ReturnType<typeof vi.fn>;
      logger: { log: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
    } {
      const calls: string[] = [];
      const onExit = vi.fn();
      const logger = { log: vi.fn(), error: vi.fn() };

      const deps: ShutdownHandlerDeps = {
        sessionCoordinator: {
          stop: vi.fn(async () => {
            calls.push("session");
          }),
        },
        cloudflared: {
          stop: vi.fn(async () => {
            calls.push("cloudflared");
          }),
        },
        daemon: {
          stop: vi.fn(async () => {
            calls.push("daemon");
          }),
        },
        httpServer: {
          close: vi.fn((cb: () => void) => {
            calls.push("http-close");
            cb();
          }),
        },
        onExit,
        logger,
        timeoutMs: 10_000,
      };

      return { deps: { ...deps, ...overrides }, calls, onExit, logger };
    }

    it("stops services in order and exits 0 after HTTP close", async () => {
      const { deps, calls, onExit } = buildDeps();
      const shutdown = createShutdownHandler(deps);

      await shutdown();

      expect(calls).toEqual(["session", "cloudflared", "daemon", "http-close"]);
      expect(onExit).toHaveBeenCalledWith(0);
    });

    it("continues shutdown even if a stopper throws", async () => {
      const { deps, calls, onExit } = buildDeps({
        sessionCoordinator: {
          stop: vi.fn(async () => {
            throw new Error("boom");
          }),
        },
      });
      const shutdown = createShutdownHandler(deps);

      await shutdown();

      expect(calls).toEqual(["cloudflared", "daemon", "http-close"]);
      expect(onExit).toHaveBeenCalledWith(0);
    });

    it("forces exit on second invocation", async () => {
      const { deps, onExit, logger } = buildDeps({
        sessionCoordinator: { stop: vi.fn(() => new Promise(() => {})) },
      });
      const shutdown = createShutdownHandler(deps);

      void shutdown();
      await shutdown();

      expect(logger.log).toHaveBeenCalledWith("\n  Force exiting...");
      expect(onExit).toHaveBeenCalledWith(1);
    });

    it("forces exit when shutdown times out", async () => {
      vi.useFakeTimers();
      const { deps, onExit, logger } = buildDeps({
        sessionCoordinator: { stop: vi.fn(() => new Promise(() => {})) },
        timeoutMs: 5_000,
      });
      const shutdown = createShutdownHandler(deps);

      void shutdown();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(logger.error).toHaveBeenCalledWith("  Shutdown timed out, force exiting.");
      expect(onExit).toHaveBeenCalledWith(1);
    });
  });

  describe("isCliEntrypoint", () => {
    it("returns true when urls match process argv path", () => {
      const entry = resolve("/tmp/beamcode.js");
      expect(isCliEntrypoint(pathToFileURL(entry).href, entry)).toBe(true);
    });

    it("returns false when argv path is missing", () => {
      expect(isCliEntrypoint(pathToFileURL("/tmp/beamcode.js").href, undefined)).toBe(false);
    });
  });
});
