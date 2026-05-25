// Ported from tests/test_trajectory_compressor.py — TestTrajectoryMetrics, TestAggregateMetrics

import { describe, expect, it } from "vitest";
import { AggregateMetrics, TrajectoryMetrics } from "../src/metrics.js";

describe("TrajectoryMetrics", () => {
  it("toDict reflects assigned fields", () => {
    const m = new TrajectoryMetrics();
    m.originalTokens = 10000;
    m.compressedTokens = 5000;
    m.tokensSaved = 5000;
    m.compressionRatio = 0.5;
    m.originalTurns = 20;
    m.compressedTurns = 10;
    m.turnsRemoved = 10;
    m.wasCompressed = true;
    const d = m.toDict();
    expect(d.original_tokens).toBe(10000);
    expect(d.compressed_tokens).toBe(5000);
    expect(d.compression_ratio).toBe(0.5);
    expect(d.was_compressed).toBe(true);
    expect(d.compression_region.start_idx).toBe(-1);
    expect(d.compression_region.end_idx).toBe(-1);
    expect(d.compression_region.turns_count).toBe(0);
  });

  it("default values", () => {
    const m = new TrajectoryMetrics();
    const d = m.toDict();
    expect(d.original_tokens).toBe(0);
    expect(d.was_compressed).toBe(false);
    expect(d.skipped_under_target).toBe(false);
    expect(d.tokens_saved).toBe(0);
    expect(d.compression_ratio).toBe(1);
    expect(d.original_turns).toBe(0);
    expect(d.compressed_turns).toBe(0);
    expect(d.turns_removed).toBe(0);
    expect(d.still_over_limit).toBe(false);
    expect(d.summarization_api_calls).toBe(0);
    expect(d.summarization_errors).toBe(0);
  });

  it("compression_region picks up assigned indices", () => {
    const m = new TrajectoryMetrics();
    m.turnsCompressedStartIdx = 3;
    m.turnsCompressedEndIdx = 7;
    m.turnsInCompressedRegion = 4;
    const d = m.toDict();
    expect(d.compression_region).toEqual({ start_idx: 3, end_idx: 7, turns_count: 4 });
  });
});

describe("AggregateMetrics", () => {
  it("empty toDict — no division by zero", () => {
    const agg = new AggregateMetrics();
    const d = agg.toDict();
    expect(d.summary.total_trajectories).toBe(0);
    expect(d.averages.avg_compression_ratio).toBe(1.0);
    expect(d.averages.avg_tokens_saved_per_compressed).toBe(0);
    expect(d.averages.avg_turns_removed_per_compressed).toBe(0);
    expect(d.summarization.success_rate).toBe(1.0);
    expect(d.tokens.overall_compression_ratio).toBe(0.0);
    expect(d.summary.compression_rate).toBe(0);
    expect(d.processing.duration_seconds).toBe(0);
  });

  it("addTrajectoryMetrics — compressed", () => {
    const agg = new AggregateMetrics();
    const m = new TrajectoryMetrics();
    m.originalTokens = 20000;
    m.compressedTokens = 10000;
    m.tokensSaved = 10000;
    m.compressionRatio = 0.5;
    m.originalTurns = 30;
    m.compressedTurns = 15;
    m.turnsRemoved = 15;
    m.wasCompressed = true;
    agg.addTrajectoryMetrics(m);
    expect(agg.totalTrajectories).toBe(1);
    expect(agg.trajectoriesCompressed).toBe(1);
    expect(agg.totalTokensSaved).toBe(10000);
    expect(agg.compressionRatios.length).toBe(1);
    expect(agg.tokensSavedList).toEqual([10000]);
    expect(agg.turnsRemovedList).toEqual([15]);
  });

  it("addTrajectoryMetrics — skipped", () => {
    const agg = new AggregateMetrics();
    const m = new TrajectoryMetrics();
    m.originalTokens = 5000;
    m.compressedTokens = 5000;
    m.skippedUnderTarget = true;
    agg.addTrajectoryMetrics(m);
    expect(agg.trajectoriesSkippedUnderTarget).toBe(1);
    expect(agg.trajectoriesCompressed).toBe(0);
  });

  it("addTrajectoryMetrics — still over limit", () => {
    const agg = new AggregateMetrics();
    const m = new TrajectoryMetrics();
    m.originalTokens = 20000;
    m.compressedTokens = 16000;
    m.stillOverLimit = true;
    m.wasCompressed = true;
    m.compressionRatio = 0.8;
    agg.addTrajectoryMetrics(m);
    expect(agg.trajectoriesStillOverLimit).toBe(1);
  });

  it("aggregates multiple trajectories", () => {
    const agg = new AggregateMetrics();
    for (let i = 0; i < 3; i += 1) {
      const m = new TrajectoryMetrics();
      m.originalTokens = 10000;
      m.compressedTokens = 5000;
      m.tokensSaved = 5000;
      m.turnsRemoved = 5;
      m.wasCompressed = true;
      m.compressionRatio = 0.5;
      m.summarizationApiCalls = 1;
      m.summarizationErrors = 0;
      agg.addTrajectoryMetrics(m);
    }
    const d = agg.toDict();
    expect(d.summary.total_trajectories).toBe(3);
    expect(d.summary.trajectories_compressed).toBe(3);
    expect(d.tokens.total_saved).toBe(15000);
    expect(d.averages.avg_compression_ratio).toBe(0.5);
    expect(d.averages.avg_tokens_saved_per_compressed).toBe(5000);
    expect(d.averages.avg_turns_removed_per_compressed).toBe(5);
    expect(d.summarization.total_api_calls).toBe(3);
    expect(d.summarization.total_errors).toBe(0);
    expect(d.summarization.success_rate).toBe(1.0);
    expect(d.summary.compression_rate).toBe(1.0);
  });

  it("success rate reflects errors", () => {
    const agg = new AggregateMetrics();
    const m = new TrajectoryMetrics();
    m.summarizationApiCalls = 4;
    m.summarizationErrors = 1;
    agg.addTrajectoryMetrics(m);
    const d = agg.toDict();
    expect(d.summarization.success_rate).toBe(0.75);
  });

  it("totals propagate from added metrics", () => {
    const agg = new AggregateMetrics();
    const m1 = new TrajectoryMetrics();
    m1.originalTokens = 100;
    m1.compressedTokens = 80;
    m1.originalTurns = 4;
    m1.compressedTurns = 3;
    m1.turnsRemoved = 1;
    m1.summarizationApiCalls = 2;
    m1.summarizationErrors = 0;
    agg.addTrajectoryMetrics(m1);

    const m2 = new TrajectoryMetrics();
    m2.originalTokens = 200;
    m2.compressedTokens = 100;
    m2.originalTurns = 6;
    m2.compressedTurns = 4;
    m2.turnsRemoved = 2;
    m2.summarizationApiCalls = 1;
    m2.summarizationErrors = 1;
    agg.addTrajectoryMetrics(m2);

    expect(agg.totalTokensBefore).toBe(300);
    expect(agg.totalTokensAfter).toBe(180);
    expect(agg.totalTurnsBefore).toBe(10);
    expect(agg.totalTurnsAfter).toBe(7);
    expect(agg.totalTurnsRemoved).toBe(3);
    expect(agg.totalSummarizationCalls).toBe(3);
    expect(agg.totalSummarizationErrors).toBe(1);
  });

  it("processing timestamps + duration round-trip via toDict", () => {
    const agg = new AggregateMetrics();
    agg.processingStartTime = "2026-01-01T00:00:00.000Z";
    agg.processingEndTime = "2026-01-01T00:00:01.500Z";
    agg.processingDurationSeconds = 1.5;
    const d = agg.toDict();
    expect(d.processing.start_time).toBe("2026-01-01T00:00:00.000Z");
    expect(d.processing.end_time).toBe("2026-01-01T00:00:01.500Z");
    expect(d.processing.duration_seconds).toBe(1.5);
  });
});
