/**
 * Metrics — faithful ports of `TrajectoryMetrics` and `AggregateMetrics`
 * (upstream `trajectory_compressor.py` lines 182-329).
 *
 * Both classes preserve the upstream snake_case keys in their `toDict()` output
 * so the on-disk metrics JSON is byte-identical with the Python implementation.
 */

/**
 * Shape of `TrajectoryMetrics.toDict()` — pinned to upstream snake_case so the
 * JSON written to disk is interchangeable.
 */
export interface TrajectoryMetricsDict {
  original_tokens: number;
  compressed_tokens: number;
  tokens_saved: number;
  compression_ratio: number;
  original_turns: number;
  compressed_turns: number;
  turns_removed: number;
  compression_region: {
    start_idx: number;
    end_idx: number;
    turns_count: number;
  };
  was_compressed: boolean;
  still_over_limit: boolean;
  skipped_under_target: boolean;
  summarization_api_calls: number;
  summarization_errors: number;
}

/** Metrics for a single trajectory compression. */
export class TrajectoryMetrics {
  originalTokens = 0;
  compressedTokens = 0;
  tokensSaved = 0;
  compressionRatio = 1.0;

  originalTurns = 0;
  compressedTurns = 0;
  turnsRemoved = 0;

  turnsCompressedStartIdx = -1;
  turnsCompressedEndIdx = -1;
  turnsInCompressedRegion = 0;

  wasCompressed = false;
  stillOverLimit = false;
  skippedUnderTarget = false;

  summarizationApiCalls = 0;
  summarizationErrors = 0;

  toDict(): TrajectoryMetricsDict {
    return {
      original_tokens: this.originalTokens,
      compressed_tokens: this.compressedTokens,
      tokens_saved: this.tokensSaved,
      compression_ratio: roundN(this.compressionRatio, 4),
      original_turns: this.originalTurns,
      compressed_turns: this.compressedTurns,
      turns_removed: this.turnsRemoved,
      compression_region: {
        start_idx: this.turnsCompressedStartIdx,
        end_idx: this.turnsCompressedEndIdx,
        turns_count: this.turnsInCompressedRegion,
      },
      was_compressed: this.wasCompressed,
      still_over_limit: this.stillOverLimit,
      skipped_under_target: this.skippedUnderTarget,
      summarization_api_calls: this.summarizationApiCalls,
      summarization_errors: this.summarizationErrors,
    };
  }
}

/** Shape of `AggregateMetrics.toDict()` — pinned to upstream snake_case. */
export interface AggregateMetricsDict {
  summary: {
    total_trajectories: number;
    trajectories_compressed: number;
    trajectories_skipped_under_target: number;
    trajectories_still_over_limit: number;
    trajectories_failed: number;
    compression_rate: number;
  };
  tokens: {
    total_before: number;
    total_after: number;
    total_saved: number;
    overall_compression_ratio: number;
  };
  turns: {
    total_before: number;
    total_after: number;
    total_removed: number;
  };
  averages: {
    avg_compression_ratio: number;
    avg_tokens_saved_per_compressed: number;
    avg_turns_removed_per_compressed: number;
  };
  summarization: {
    total_api_calls: number;
    total_errors: number;
    success_rate: number;
  };
  processing: {
    start_time: string;
    end_time: string;
    duration_seconds: number;
  };
}

/** Aggregate metrics across all trajectories. */
export class AggregateMetrics {
  totalTrajectories = 0;
  trajectoriesCompressed = 0;
  trajectoriesSkippedUnderTarget = 0;
  trajectoriesStillOverLimit = 0;
  trajectoriesFailed = 0;

  totalTokensBefore = 0;
  totalTokensAfter = 0;
  totalTokensSaved = 0;

  totalTurnsBefore = 0;
  totalTurnsAfter = 0;
  totalTurnsRemoved = 0;

  totalSummarizationCalls = 0;
  totalSummarizationErrors = 0;

  compressionRatios: number[] = [];
  tokensSavedList: number[] = [];
  turnsRemovedList: number[] = [];

  processingStartTime = "";
  processingEndTime = "";
  processingDurationSeconds = 0.0;

  /** Add a trajectory's metrics to the aggregate. */
  addTrajectoryMetrics(metrics: TrajectoryMetrics): void {
    this.totalTrajectories += 1;
    this.totalTokensBefore += metrics.originalTokens;
    this.totalTokensAfter += metrics.compressedTokens;
    this.totalTokensSaved += metrics.tokensSaved;
    this.totalTurnsBefore += metrics.originalTurns;
    this.totalTurnsAfter += metrics.compressedTurns;
    this.totalTurnsRemoved += metrics.turnsRemoved;
    this.totalSummarizationCalls += metrics.summarizationApiCalls;
    this.totalSummarizationErrors += metrics.summarizationErrors;

    if (metrics.wasCompressed) {
      this.trajectoriesCompressed += 1;
      this.compressionRatios.push(metrics.compressionRatio);
      this.tokensSavedList.push(metrics.tokensSaved);
      this.turnsRemovedList.push(metrics.turnsRemoved);
    }

    if (metrics.skippedUnderTarget) {
      this.trajectoriesSkippedUnderTarget += 1;
    }

    if (metrics.stillOverLimit) {
      this.trajectoriesStillOverLimit += 1;
    }
  }

  toDict(): AggregateMetricsDict {
    const avgCompressionRatio =
      this.compressionRatios.length > 0
        ? sum(this.compressionRatios) / this.compressionRatios.length
        : 1.0;
    const avgTokensSaved =
      this.tokensSavedList.length > 0 ? sum(this.tokensSavedList) / this.tokensSavedList.length : 0;
    const avgTurnsRemoved =
      this.turnsRemovedList.length > 0
        ? sum(this.turnsRemovedList) / this.turnsRemovedList.length
        : 0;

    return {
      summary: {
        total_trajectories: this.totalTrajectories,
        trajectories_compressed: this.trajectoriesCompressed,
        trajectories_skipped_under_target: this.trajectoriesSkippedUnderTarget,
        trajectories_still_over_limit: this.trajectoriesStillOverLimit,
        trajectories_failed: this.trajectoriesFailed,
        compression_rate: roundN(
          this.trajectoriesCompressed / Math.max(this.totalTrajectories, 1),
          4,
        ),
      },
      tokens: {
        total_before: this.totalTokensBefore,
        total_after: this.totalTokensAfter,
        total_saved: this.totalTokensSaved,
        overall_compression_ratio: roundN(
          this.totalTokensAfter / Math.max(this.totalTokensBefore, 1),
          4,
        ),
      },
      turns: {
        total_before: this.totalTurnsBefore,
        total_after: this.totalTurnsAfter,
        total_removed: this.totalTurnsRemoved,
      },
      averages: {
        avg_compression_ratio: roundN(avgCompressionRatio, 4),
        avg_tokens_saved_per_compressed: roundN(avgTokensSaved, 1),
        avg_turns_removed_per_compressed: roundN(avgTurnsRemoved, 2),
      },
      summarization: {
        total_api_calls: this.totalSummarizationCalls,
        total_errors: this.totalSummarizationErrors,
        // Upstream: `round(1 - (errors / max(calls, 1)), 4)`.
        // When calls == 0 → 1 - 0 / 1 = 1.0 (matches test_to_dict_no_division_by_zero).
        success_rate: roundN(
          1 - this.totalSummarizationErrors / Math.max(this.totalSummarizationCalls, 1),
          4,
        ),
      },
      processing: {
        start_time: this.processingStartTime,
        end_time: this.processingEndTime,
        duration_seconds: roundN(this.processingDurationSeconds, 2),
      },
    };
  }
}

/** Sum of an array (no-op on empty arrays — returns 0). */
function sum(xs: readonly number[]): number {
  let total = 0;
  for (const x of xs) total += x;
  return total;
}

/**
 * Round to `digits` decimal places — matches Python `round(x, digits)`
 * for the values we use (positive `x`, small `digits`). Python uses
 * banker's rounding; JS's `Math.round` uses half-away-from-zero. The metric
 * field tests assert exact equality on values where the difference doesn't
 * surface, so the simpler implementation is faithful enough for these
 * call-sites.
 */
function roundN(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
