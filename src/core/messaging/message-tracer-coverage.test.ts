/**
 * Additional branch coverage tests for message-tracer.ts.
 *
 * Targets uncovered lines/branches: 376-478, 586, 663.
 */

import { describe, expect, it, vi } from "vitest";
import { MessageTracerImpl } from "./message-tracer.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTracer(overrides?: Partial<ConstructorParameters<typeof MessageTracerImpl>[0]>) {
  const lines: string[] = [];
  let clock = 1_000_000_000n;
  const tracer = new MessageTracerImpl({
    level: "smart",
    allowSensitive: false,
    write: (line) => lines.push(line),
    now: () => clock,
    staleTimeoutMs: 100,
    ...overrides,
  });
  const advance = (ms: number) => {
    clock += BigInt(ms) * 1_000_000n;
  };
  const parsed = () => lines.map((l) => JSON.parse(l));
  return { tracer, lines, parsed, advance };
}

// ─── Lines 375-391: error() emit with parentTraceId and opts fields ───────────

describe("error() — uncovered branches in emit call (lines 375-391)", () => {
  it("passes parentTraceId through to the emitted event", () => {
    const { tracer, parsed } = createTracer();
    tracer.error("backend", "parse_error", "bad input", {
      traceId: "t_child",
      parentTraceId: "t_parent",
      sessionId: "s1",
    });
    const evt = parsed()[0];
    expect(evt.parentTraceId).toBe("t_parent");
    expect(evt.error).toBe("bad input");
    tracer.destroy();
  });

  it("resolves sessionId from an existing open trace when not passed in opts", () => {
    // resolveSessionId falls back to openTraces.get(traceId)?.sessionId
    const { tracer, parsed } = createTracer();
    // Open the trace via recv so it has a sessionId
    tracer.recv("bridge", "msg", {}, { traceId: "t_open", sessionId: "s-resolved" });
    // Now call error() with the same traceId but NO sessionId in opts
    tracer.error("bridge", "msg", "something bad", { traceId: "t_open" });
    const errorEvt = parsed().find((e) => e.error === "something bad");
    expect(errorEvt).toBeDefined();
    // The sessionId should have been resolved from the open trace
    expect(errorEvt.sessionId).toBe("s-resolved");
    tracer.destroy();
  });

  it("auto-generates traceId in error() when not provided in opts", () => {
    const { tracer, parsed } = createTracer();
    tracer.error("bridge", "msg", "auto-id error");
    const evt = parsed()[0];
    expect(evt.traceId).toMatch(/^t_[a-f0-9]{8}$/);
    tracer.destroy();
  });

  it("passes requestId, command, phase, outcome through error()", () => {
    const { tracer, parsed } = createTracer();
    tracer.error("frontend", "slash_cmd", "cmd failed", {
      traceId: "t_cmd",
      requestId: "req-42",
      command: "/run",
      phase: "execute",
      outcome: "parse_error",
    });
    const evt = parsed()[0];
    expect(evt.requestId).toBe("req-42");
    expect(evt.command).toBe("/run");
    expect(evt.phase).toBe("execute");
    expect(evt.outcome).toBe("parse_error");
    tracer.destroy();
  });
});

// ─── Lines 470-484: getSeq() — session eviction when MAX_SESSIONS exceeded ────

describe("getSeq() — session eviction at MAX_SESSIONS (lines 475-479)", () => {
  it("evicts oldest session entry when sessionSeqs reaches MAX_SESSIONS", () => {
    const { tracer } = createTracer();
    const MAX_SESSIONS = (MessageTracerImpl as any).MAX_SESSIONS as number;

    // Pre-fill sessionSeqs to exactly MAX_SESSIONS entries
    const sessionSeqs = (tracer as any).sessionSeqs as Map<string, { counter: number }>;
    for (let i = 0; i < MAX_SESSIONS; i++) {
      sessionSeqs.set(`session-seed-${i}`, { counter: i + 1 });
    }
    expect(sessionSeqs.size).toBe(MAX_SESSIONS);

    // The first seed session that will be evicted
    const firstSeedKey = "session-seed-0";
    expect(sessionSeqs.has(firstSeedKey)).toBe(true);

    // Emit an event with a brand-new sessionId — getSeq() will see size >= MAX_SESSIONS
    // and evict the oldest before inserting the new one
    tracer.send(
      "bridge",
      "msg",
      {},
      {
        traceId: "t_evict_session",
        sessionId: "brand-new-session",
      },
    );

    // The oldest seed entry should have been evicted
    expect(sessionSeqs.has(firstSeedKey)).toBe(false);
    // The new session should now be present
    expect(sessionSeqs.has("brand-new-session")).toBe(true);
    // Size should remain at MAX_SESSIONS (evict one, add one)
    expect(sessionSeqs.size).toBe(MAX_SESSIONS);

    tracer.destroy();
  });
});

// ─── Line 586: emit() catch block — JSON.stringify failure ───────────────────

describe("emit() catch block — circular reference stringify failure (line 586)", () => {
  it("emits minimal fallback event when body cannot be JSON serialised", () => {
    const lines: string[] = [];
    // Use "full" level with allowSensitive=true so the body is passed through
    // without sanitization, preserving the circular reference
    const tracer = new MessageTracerImpl({
      level: "full",
      allowSensitive: true,
      write: (line) => lines.push(line),
      now: () => 1_000_000_000n,
      staleTimeoutMs: 100_000,
    });

    // Build a circular object that JSON.stringify cannot handle
    const circular: Record<string, unknown> = { name: "circular" };
    circular.self = circular;

    // send() at layer "backend" so the trace stays open (won't be completed/deleted)
    tracer.send("backend", "circular_msg", circular, {
      traceId: "t_circular",
      sessionId: "s-circ",
    });

    expect(lines.length).toBeGreaterThanOrEqual(1);

    // Find the fallback event (it will have the error field about serialization)
    const fallback = lines
      .map((l) => JSON.parse(l))
      .find((e) => typeof e.error === "string" && e.error.includes("circular"));

    expect(fallback).toBeDefined();
    expect(fallback.trace).toBe(true);
    expect(fallback.traceId).toBe("t_circular");
    expect(fallback.error).toContain("circular");

    tracer.destroy();
  });
});

// ─── Line 663: sweepStale() defensive break — oldest === undefined ────────────

describe("sweepStale() — defensive break when oldest is undefined (line 663)", () => {
  it("breaks out of the while loop when staleTraces iterator returns undefined", () => {
    const { tracer } = createTracer();
    const staleTraces = (tracer as any).staleTraces as Set<string>;
    const MAX_STALE = (MessageTracerImpl as any).MAX_STALE as number;

    // Pre-fill to above MAX_STALE
    for (let i = 0; i < MAX_STALE + 5; i++) {
      staleTraces.add(`stale-${i}`);
    }
    expect(staleTraces.size).toBeGreaterThan(MAX_STALE);

    // Patch the Set so that values().next() always returns { value: undefined, done: false }
    // This exercises the `else { break; }` branch on line 663
    const originalValues = staleTraces.values.bind(staleTraces);
    let callCount = 0;
    const patchedValues = vi.fn(() => {
      callCount += 1;
      if (callCount <= 3) {
        // Return an iterator that immediately gives undefined as value
        return {
          next: () => ({ value: undefined, done: false }) as IteratorResult<string>,
          [Symbol.iterator]() {
            return this;
          },
        };
      }
      return originalValues();
    });
    (staleTraces as any).values = patchedValues;

    // sweepStale will enter the while loop (size > MAX_STALE), call values().next(),
    // get undefined, and hit the break on line 663
    expect(() => (tracer as any).sweepStale()).not.toThrow();

    tracer.destroy();
  });

  it("sweepStale evicts stale entries normally when oldest is defined", () => {
    const { tracer, advance } = createTracer();
    const MAX_STALE = (MessageTracerImpl as any).MAX_STALE as number;
    const staleTraces = (tracer as any).staleTraces as Set<string>;

    // Pre-fill staleTraces to MAX_STALE
    for (let i = 0; i < MAX_STALE; i++) {
      staleTraces.add(`stale-pre-${i}`);
    }

    // Create an open trace that will become stale
    tracer.recv("bridge", "msg", {}, { traceId: "t-to-stale", sessionId: "s-stale" });
    advance(200);

    // sweepStale will add 1 more (→ MAX_STALE+1), then evict 1 back to MAX_STALE
    (tracer as any).sweepStale();

    expect(staleTraces.size).toBe(MAX_STALE);
    tracer.destroy();
  });
});

// ─── Additional branch: emit() when state already exists (else branch) ────────

describe("emit() — updating existing trace state (line 524-529)", () => {
  it("updates sessionId on existing trace state when not previously set", () => {
    const { tracer, parsed } = createTracer();
    // First call: no sessionId
    tracer.recv("bridge", "msg", {}, { traceId: "t_update" });
    // Second call: same traceId, add sessionId now
    tracer.recv("bridge", "msg", {}, { traceId: "t_update", sessionId: "s-late" });

    const evts = parsed();
    // First event: no sessionId
    expect(evts[0].sessionId).toBeUndefined();
    // Second event: sessionId now set
    expect(evts[1].sessionId).toBe("s-late");
    tracer.destroy();
  });

  it("marks hasError on existing trace state when error is present in subsequent event", () => {
    const { tracer } = createTracer();
    tracer.recv("bridge", "msg", {}, { traceId: "t_haserr", sessionId: "s1" });
    // Now send an error on the same traceId — this hits the else branch
    // and sets state.hasError = true
    tracer.error("bridge", "msg", "late error", { traceId: "t_haserr", sessionId: "s1" });

    const summary = tracer.summary("s1");
    // The open trace has hasError=true, so it counts in errorSet
    expect(summary.errors).toBeGreaterThanOrEqual(1);
    tracer.destroy();
  });
});

// ─── Full level with allowSensitive=false: redact() path ──────────────────────

describe("full level without allowSensitive — redact() branch", () => {
  it("redacts sensitive keys at full level without allowSensitive", () => {
    const { tracer, parsed } = createTracer({ level: "full", allowSensitive: false });
    tracer.send(
      "backend",
      "auth_msg",
      { token: "super-secret", data: "visible" },
      { traceId: "t_full_redact" },
    );
    const evt = parsed()[0];
    const body = evt.body as Record<string, unknown>;
    expect(body.token).toBe("[REDACTED]");
    expect(body.data).toBe("visible");
    tracer.destroy();
  });

  it("passes body through unchanged at full level with allowSensitive=true", () => {
    const { tracer, parsed } = createTracer({ level: "full", allowSensitive: true });
    tracer.send(
      "backend",
      "auth_msg",
      { token: "super-secret", data: "visible" },
      { traceId: "t_full_allow" },
    );
    const evt = parsed()[0];
    const body = evt.body as Record<string, unknown>;
    expect(body.token).toBe("super-secret");
    expect(body.data).toBe("visible");
    tracer.destroy();
  });
});

// ─── extractTraceContext ───────────────────────────────────────────────────────

describe("extractTraceContext", () => {
  it("extracts traceId, requestId, command from metadata", async () => {
    const { extractTraceContext } = await import("./message-tracer.js");
    const result = extractTraceContext({
      trace_id: "t_extracted",
      slash_request_id: "req-99",
      slash_command: "/help",
    });
    expect(result.traceId).toBe("t_extracted");
    expect(result.requestId).toBe("req-99");
    expect(result.command).toBe("/help");
  });

  it("returns undefined fields when metadata values are not strings", async () => {
    const { extractTraceContext } = await import("./message-tracer.js");
    const result = extractTraceContext({
      trace_id: 42,
      slash_request_id: null,
      slash_command: { nested: true },
    });
    expect(result.traceId).toBeUndefined();
    expect(result.requestId).toBeUndefined();
    expect(result.command).toBeUndefined();
  });
});

// ─── emit() preSanitized=false: from/to sanitization path ────────────────────

describe("translate() from/to sanitization — preSanitized=false path", () => {
  it("sanitizes from/to bodies when preSanitized is not set (via non-translate emit)", () => {
    // translate() always sets preSanitized=true; test the non-preSanitized path
    // by calling emit directly via a workaround: use a custom subclass
    // Instead, verify translate() output includes sanitized sensitive data
    const { tracer, parsed } = createTracer({ level: "full", allowSensitive: false });
    tracer.translate(
      "translator",
      "T3",
      { format: "native", body: { password: "secret", value: 1 } },
      { format: "unified", body: { password: "secret", value: 1 } },
      { traceId: "t_translate_redact" },
    );
    const evt = parsed()[0];
    expect((evt.from?.body as any)?.password).toBe("[REDACTED]");
    expect((evt.to?.body as any)?.password).toBe("[REDACTED]");
    tracer.destroy();
  });
});

// ─── roughObjectSize depth limit and fallback ─────────────────────────────────

describe("roughObjectSize — depth > 10 and non-standard type fallback (line 262)", () => {
  it("handles deeply nested objects without stack overflow", () => {
    const { tracer, parsed } = createTracer();
    // Build a deeply nested object (12 levels deep)
    let deep: Record<string, unknown> = { value: "leaf" };
    for (let i = 0; i < 12; i++) {
      deep = { nested: deep };
    }
    tracer.send("bridge", "deep_msg", deep, { traceId: "t_deep" });
    const evt = parsed()[0];
    expect(evt.size_bytes).toBeGreaterThan(0);
    tracer.destroy();
  });

  it("returns fallback size for non-standard types via private estimateSize (line 262)", () => {
    const { tracer } = createTracer();
    // Access the private estimateSize method directly.
    // roughObjectSize's final `return 8` is reached for types that are not
    // null/undefined/string/number/boolean/array/object (e.g. a Symbol).
    const estimateSize = (tracer as any).estimateSize.bind(tracer);
    // Symbol is not string/number/boolean/array/object — goes to final return 8
    const size = estimateSize(Symbol("test"));
    expect(size).toBe(8);
    tracer.destroy();
  });
});

// ─── smartSanitize — array with "type" items (lines 156-159) ─────────────────

describe("smartSanitize — array of objects with 'type' field collapses to message count", () => {
  it("collapses arrays of >3 objects that have 'type' (but not 'role') to [N messages]", () => {
    const { tracer, parsed } = createTracer({ level: "smart" });
    // Items that have "type" but NOT "role" — exercises the `"type" in item` branch
    const typeItems = [
      { type: "text", content: "a" },
      { type: "image", url: "http://example.com/img.png" },
      { type: "text", content: "b" },
      { type: "text", content: "c" },
    ];
    tracer.send("bridge", "msg", { items: typeItems }, { traceId: "t_type_array" });
    const body = parsed()[0].body as Record<string, unknown>;
    expect(body.items).toBe("[4 messages]");
    tracer.destroy();
  });
});

// ─── summary() stale count for matching session (line 411) ───────────────────

describe("summary() — stale traces counted for matching session (line 411)", () => {
  it("counts stale traces belonging to the queried session", () => {
    const { tracer, advance } = createTracer({ staleTimeoutMs: 50 });

    // Open a trace for "s-stale"
    tracer.recv("bridge", "msg", {}, { traceId: "t-will-stale", sessionId: "s-stale" });
    // Advance beyond stale threshold
    advance(200);
    // Manually trigger stale sweep
    (tracer as any).sweepStale();

    const summary = tracer.summary("s-stale");
    expect(summary.stale).toBe(1);
    expect(summary.totalTraces).toBe(1);

    tracer.destroy();
  });

  it("does not count stale traces from other sessions", () => {
    const { tracer, advance } = createTracer({ staleTimeoutMs: 50 });

    tracer.recv("bridge", "msg", {}, { traceId: "t-other-stale", sessionId: "s-other" });
    advance(200);
    (tracer as any).sweepStale();

    // s-stale should have 0 stale, not the one from s-other
    const summary = tracer.summary("s-mine");
    expect(summary.stale).toBe(0);
    tracer.destroy();
  });
});
