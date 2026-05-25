import { describe, expect, it, vi } from "vitest";

import { AggregateMetrics, TrajectoryMetrics } from "../src/metrics.js";
import { formatCompressionReport, printCompressionReport } from "../src/report.js";

function makeAggregate(): AggregateMetrics {
  const agg = new AggregateMetrics();
  agg.processingStartTime = "2026-05-25T10:00:00.000Z";
  agg.processingEndTime = "2026-05-25T10:00:05.000Z";
  agg.processingDurationSeconds = 5.0;
  return agg;
}

describe("formatCompressionReport", () => {
  it("formats an empty aggregate (header + zero rows)", () => {
    const lines = formatCompressionReport(new AggregateMetrics());
    const joined = lines.join("\n");
    expect(joined).toContain("TRAJECTORY COMPRESSION REPORT");
    expect(joined).toContain("Total Processed:");
    expect(joined).toContain("No trajectories were compressed");
    // No "Space Savings" row when total_before == 0.
    expect(joined).not.toContain("Space Savings:");
  });

  it("formats a populated aggregate with compressed trajectories", () => {
    const agg = makeAggregate();
    for (let i = 0; i < 3; i += 1) {
      const m = new TrajectoryMetrics();
      m.originalTokens = 100;
      m.compressedTokens = 50;
      m.tokensSaved = 50;
      m.originalTurns = 5;
      m.compressedTurns = 3;
      m.turnsRemoved = 2;
      m.wasCompressed = true;
      m.compressionRatio = 0.5;
      m.summarizationApiCalls = 1;
      m.summarizationErrors = 0;
      agg.addTrajectoryMetrics(m);
    }
    const lines = formatCompressionReport(agg);
    const joined = lines.join("\n");
    expect(joined).toContain("Space Savings:");
    expect(joined).toContain("Avg Compression Ratio:");
    expect(joined).toContain("Distribution Summary:");
    expect(joined).toContain("Compression ratios:");
    expect(joined).toContain("Tokens saved:");
  });

  it("formats long durations in minutes", () => {
    const agg = new AggregateMetrics();
    agg.processingDurationSeconds = 125;
    const lines = formatCompressionReport(agg);
    const joined = lines.join("\n");
    expect(joined).toContain("minutes");
  });

  it("handles odd-length distribution arrays via median index", () => {
    const agg = new AggregateMetrics();
    for (let i = 0; i < 5; i += 1) {
      const m = new TrajectoryMetrics();
      m.wasCompressed = true;
      m.compressionRatio = 0.1 * (i + 1);
      m.tokensSaved = (i + 1) * 10;
      agg.addTrajectoryMetrics(m);
    }
    const lines = formatCompressionReport(agg);
    expect(lines.some((l) => l.includes("median="))).toBe(true);
  });
});

describe("printCompressionReport", () => {
  it("emits formatted lines through the provided sink", () => {
    const sink = { log: vi.fn() };
    printCompressionReport(new AggregateMetrics(), sink);
    expect(sink.log).toHaveBeenCalled();
  });

  it("defaults to globalThis.console.log when no sink provided", () => {
    const spy = vi.spyOn(globalThis.console, "log").mockImplementation(() => undefined);
    try {
      printCompressionReport(new AggregateMetrics());
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
