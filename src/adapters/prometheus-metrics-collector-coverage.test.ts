import { describe, expect, it } from "vitest";
import type { MetricsEventType } from "../interfaces/metrics.js";
import { PrometheusMetricsCollector } from "./prometheus-metrics-collector.js";

// Dynamic import so test fails gracefully if prom-client missing
let promClient: typeof import("prom-client");
try {
  promClient = await import("prom-client");
} catch {
  // Tests will be skipped below
}

const describeIfProm = promClient! ? describe : describe.skip;

function makeCollector() {
  return new PrometheusMetricsCollector(promClient);
}

describeIfProm("PrometheusMetricsCollector — uncovered branches", () => {
  it("decrements consumers_active on consumer:disconnected (line 144-146)", async () => {
    const c = makeCollector();

    c.recordEvent({
      timestamp: Date.now(),
      type: "consumer:connected",
      sessionId: "s1",
      userId: "u1",
    } as MetricsEventType);

    const before = await c.getMetricsOutput();
    expect(before).toContain("beamcode_consumers_active 1");

    c.recordEvent({
      timestamp: Date.now(),
      type: "consumer:disconnected",
      sessionId: "s1",
      userId: "u1",
    } as MetricsEventType);

    const after = await c.getMetricsOutput();
    expect(after).toContain("beamcode_consumers_active 0");
  });

  it("decrements backends_active on backend:disconnected (line 150-152)", async () => {
    const c = makeCollector();

    c.recordEvent({
      timestamp: Date.now(),
      type: "backend:connected",
      sessionId: "s1",
    } as MetricsEventType);

    const before = await c.getMetricsOutput();
    expect(before).toContain("beamcode_backends_active 1");

    c.recordEvent({
      timestamp: Date.now(),
      type: "backend:disconnected",
      sessionId: "s1",
    } as MetricsEventType);

    const after = await c.getMetricsOutput();
    expect(after).toContain("beamcode_backends_active 0");
  });
});
