/**
 * Compression report formatter — faithful port of
 * `TrajectoryCompressor._print_summary` (upstream `trajectory_compressor.py`
 * lines 1181-1287).
 *
 * Returns a list of report lines instead of writing to stdout so callers
 * can route the output anywhere (CLI, log file, structured event). The
 * Python `_print_summary` is kept as a thin wrapper that calls
 * `console.log` on each returned line.
 */

import type { AggregateMetrics } from "./metrics.js";

/** Report title, exported so tests can reuse the exact string. */
export const REPORT_TITLE = "TRAJECTORY COMPRESSION REPORT";

/**
 * Format the aggregate metrics into the boxed text report used by the upstream
 * CLI. Returns the lines in order; each line excludes the trailing newline.
 *
 * The layout matches the upstream report character-for-character within the
 * widths the upstream `print` statements set up — the box width is 72 columns
 * (70 dashes + 2 walls).
 */
export function formatCompressionReport(aggregate: AggregateMetrics): string[] {
  const m = aggregate.toDict();
  const lines: string[] = [];

  const total = m.summary.total_trajectories;
  const compressed = m.summary.trajectories_compressed;
  const skipped = m.summary.trajectories_skipped_under_target;
  const overLimit = m.summary.trajectories_still_over_limit;
  const failed = m.summary.trajectories_failed;

  const tokensBefore = m.tokens.total_before;
  const tokensAfter = m.tokens.total_after;
  const tokensSaved = m.tokens.total_saved;

  const compressedPct = (compressed / Math.max(total, 1)) * 100;
  const skippedPct = (skipped / Math.max(total, 1)) * 100;
  const overLimitPct = (overLimit / Math.max(total, 1)) * 100;

  lines.push("");

  lines.push(`╔${"═".repeat(70)}╗`);
  lines.push(`║${centerInBox(REPORT_TITLE, 70)}║`);
  lines.push(`╠${"═".repeat(70)}╣`);

  // Trajectories section.
  lines.push(`║${"".padStart(2)}📁 TRAJECTORIES${" ".repeat(54)}║`);
  lines.push(`║${"─".repeat(70)}║`);
  lines.push(`║${"".padStart(4)}Total Processed:        ${formatInt(total, 10)}${" ".repeat(32)}║`);
  lines.push(
    `║${"".padStart(4)}├─ Compressed:          ${formatInt(compressed, 10)}  (${formatPct(compressedPct, 5, 1)})${" ".repeat(18)}║`,
  );
  lines.push(
    `║${"".padStart(4)}├─ Skipped (under limit):${formatInt(skipped, 9)}  (${formatPct(skippedPct, 5, 1)})${" ".repeat(18)}║`,
  );
  lines.push(
    `║${"".padStart(4)}├─ Still over limit:    ${formatInt(overLimit, 10)}  (${formatPct(overLimitPct, 5, 1)})${" ".repeat(18)}║`,
  );
  lines.push(
    `║${"".padStart(4)}└─ Failed:              ${formatInt(failed, 10)}${" ".repeat(32)}║`,
  );

  lines.push(`╠${"═".repeat(70)}╣`);

  // Tokens section.
  lines.push(`║${"".padStart(2)}🔢 TOKENS${" ".repeat(60)}║`);
  lines.push(`║${"─".repeat(70)}║`);
  lines.push(
    `║${"".padStart(4)}Before Compression:     ${formatInt(tokensBefore, 15)} tokens${" ".repeat(21)}║`,
  );
  lines.push(
    `║${"".padStart(4)}After Compression:      ${formatInt(tokensAfter, 15)} tokens${" ".repeat(21)}║`,
  );
  lines.push(
    `║${"".padStart(4)}Total Saved:            ${formatInt(tokensSaved, 15)} tokens${" ".repeat(21)}║`,
  );
  lines.push(
    `║${"".padStart(4)}Overall Compression:    ${formatPct(m.tokens.overall_compression_ratio * 100, 14, 1)}${" ".repeat(28)}║`,
  );

  if (tokensBefore > 0) {
    const savingsPct = (tokensSaved / tokensBefore) * 100;
    lines.push(
      `║${"".padStart(4)}Space Savings:          ${formatFloat(savingsPct, 14, 1)}%${" ".repeat(28)}║`,
    );
  }

  lines.push(`╠${"═".repeat(70)}╣`);

  // Turns section.
  lines.push(`║${"".padStart(2)}💬 CONVERSATION TURNS${" ".repeat(48)}║`);
  lines.push(`║${"─".repeat(70)}║`);
  lines.push(
    `║${"".padStart(4)}Before Compression:     ${formatInt(m.turns.total_before, 15)} turns${" ".repeat(22)}║`,
  );
  lines.push(
    `║${"".padStart(4)}After Compression:      ${formatInt(m.turns.total_after, 15)} turns${" ".repeat(22)}║`,
  );
  lines.push(
    `║${"".padStart(4)}Total Removed:          ${formatInt(m.turns.total_removed, 15)} turns${" ".repeat(22)}║`,
  );

  lines.push(`╠${"═".repeat(70)}╣`);

  // Averages section.
  lines.push(`║${"".padStart(2)}📈 AVERAGES (Compressed Trajectories Only)${" ".repeat(27)}║`);
  lines.push(`║${"─".repeat(70)}║`);
  if (compressed > 0) {
    lines.push(
      `║${"".padStart(4)}Avg Compression Ratio:  ${formatPct(m.averages.avg_compression_ratio * 100, 14, 1)}${" ".repeat(28)}║`,
    );
    lines.push(
      `║${"".padStart(4)}Avg Tokens Saved:       ${formatFloat(m.averages.avg_tokens_saved_per_compressed, 14, 0)}${" ".repeat(28)}║`,
    );
    lines.push(
      `║${"".padStart(4)}Avg Turns Removed:      ${formatFloat(m.averages.avg_turns_removed_per_compressed, 14, 1)}${" ".repeat(28)}║`,
    );
  } else {
    lines.push(`║${"".padStart(4)}No trajectories were compressed${" ".repeat(38)}║`);
  }

  lines.push(`╠${"═".repeat(70)}╣`);

  // Summarization section.
  lines.push(`║${"".padStart(2)}🤖 SUMMARIZATION API${" ".repeat(49)}║`);
  lines.push(`║${"─".repeat(70)}║`);
  lines.push(
    `║${"".padStart(4)}API Calls Made:         ${formatInt(m.summarization.total_api_calls, 15)}${" ".repeat(27)}║`,
  );
  lines.push(
    `║${"".padStart(4)}Errors:                 ${formatInt(m.summarization.total_errors, 15)}${" ".repeat(27)}║`,
  );
  lines.push(
    `║${"".padStart(4)}Success Rate:           ${formatPct(m.summarization.success_rate * 100, 14, 1)}${" ".repeat(28)}║`,
  );

  lines.push(`╠${"═".repeat(70)}╣`);

  // Processing-time section.
  const duration = m.processing.duration_seconds;
  const timeStr =
    duration > 60 ? `${(duration / 60).toFixed(1)} minutes` : `${duration.toFixed(1)} seconds`;
  const throughput = total / Math.max(duration, 0.001);

  lines.push(`║${"".padStart(2)}⏱️  PROCESSING TIME${" ".repeat(51)}║`);
  lines.push(`║${"─".repeat(70)}║`);
  lines.push(`║${"".padStart(4)}Duration:               ${padLeft(timeStr, 20)}${" ".repeat(22)}║`);
  lines.push(
    `║${"".padStart(4)}Throughput:             ${formatFloat(throughput, 15, 1)} traj/sec${" ".repeat(18)}║`,
  );
  // start_time/end_time default to "" in AggregateMetrics, so the nullish
  // coalescing branch is unreachable — direct .slice is safe.
  lines.push(
    `║${"".padStart(4)}Started:                ${padLeft(m.processing.start_time.slice(0, 19), 20)}${" ".repeat(22)}║`,
  );
  lines.push(
    `║${"".padStart(4)}Finished:               ${padLeft(m.processing.end_time.slice(0, 19), 20)}${" ".repeat(22)}║`,
  );

  lines.push(`╚${"═".repeat(70)}╝`);

  // Distribution summary if we have data.
  const ratios = aggregate.compressionRatios;
  const tokensSavedList = aggregate.tokensSavedList;
  if (ratios.length > 0) {
    const sortedRatios = [...ratios].sort((a, b) => a - b);
    const sortedTokens = [...tokensSavedList].sort((a, b) => a - b);

    lines.push("");
    lines.push("📊 Distribution Summary:");
    lines.push(
      `   Compression ratios: min=${formatPct(Math.min(...ratios) * 100, 0, 2)}, max=${formatPct(Math.max(...ratios) * 100, 0, 2)}, median=${formatPct(sortedRatios[Math.floor(sortedRatios.length / 2)]! * 100, 0, 2)}`,
    );
    lines.push(
      `   Tokens saved:       min=${Math.min(...tokensSavedList).toLocaleString()}, max=${Math.max(...tokensSavedList).toLocaleString()}, median=${sortedTokens[Math.floor(sortedTokens.length / 2)]!.toLocaleString()}`,
    );
  }

  return lines;
}

/**
 * Print the formatted compression report — thin wrapper around
 * `formatCompressionReport` that mimics the upstream `_print_summary`.
 */
export function printCompressionReport(
  aggregate: AggregateMetrics,
  sink: Pick<typeof globalThis.console, "log"> = globalThis.console,
): void {
  for (const line of formatCompressionReport(aggregate)) {
    sink.log(line);
  }
}

// ── Tiny number/text helpers ─────────────────────────────────────────────

/** Format an integer with comma thousand-separators, right-padded to width. */
function formatInt(value: number, width: number): string {
  return padLeft(value.toLocaleString("en-US"), width);
}

/**
 * Format a float `value.toFixed(digits)` right-padded to width. Matches
 * Python's `f'{value:>{width}.{digits}f}'`.
 */
function formatFloat(value: number, width: number, digits: number): string {
  return padLeft(value.toFixed(digits), width);
}

/**
 * Format a percentage. `value` is in 0-100 (already multiplied). Width is the
 * field width before the `%`; digits is the number of decimals. Matches
 * Python's `f'{x:>{width}.{digits}%}'` for inputs already in [0,1] — i.e. the
 * caller has done the *100 already.
 */
function formatPct(value: number, width: number, digits: number): string {
  return `${padLeft(value.toFixed(digits), width)}%`;
}

/** Right-pad `s` with spaces to `width`. */
function padLeft(s: string, width: number): string {
  if (s.length >= width) return s;
  return " ".repeat(width - s.length) + s;
}

/** Center `s` within `width` using spaces. Matches Python `f"{s:^{width}}"`. */
function centerInBox(s: string, width: number): string {
  // Safety branch: the only caller passes the fixed 29-char `REPORT_TITLE`
  // against width=70, so the no-padding case is dead but kept for parity
  // with the Python `f"{title:^{width}}"` behaviour.
  /* v8 ignore next */
  if (s.length >= width) return s;
  const pad = width - s.length;
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return " ".repeat(left) + s + " ".repeat(right);
}
