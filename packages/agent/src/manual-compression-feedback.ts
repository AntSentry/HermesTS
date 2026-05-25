/**
 * User-facing summaries for manual compression commands.
 *
 * Faithful port of upstream `agent/manual_compression_feedback.py`.
 */

/** Shape returned by `summarizeManualCompression`. */
export interface ManualCompressionSummary {
  noop: boolean;
  headline: string;
  tokenLine: string;
  note: string | null;
}

/** Format an integer with the same `{:,}` grouping Python uses. */
function formatThousands(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Return consistent user-facing feedback for manual compression.
 *
 * Mirrors upstream signature `summarize_manual_compression(before_messages,
 * after_messages, before_tokens, after_tokens)`.
 *
 * Equality of `before`/`after` is structural — matches Python's `list ==
 * list` behavior using JSON serialization (messages are JSON-shaped dicts
 * with stable insertion order in both runtimes).
 */
export function summarizeManualCompression(
  beforeMessages: ReadonlyArray<Record<string, unknown>>,
  afterMessages: ReadonlyArray<Record<string, unknown>>,
  beforeTokens: number,
  afterTokens: number,
): ManualCompressionSummary {
  const beforeCount = beforeMessages.length;
  const afterCount = afterMessages.length;
  // Use the same `messages == messages` check Python does. JSON
  // serialization is the simplest structural-equality probe that
  // tolerates arbitrary message shapes.
  const noop = JSON.stringify(beforeMessages) === JSON.stringify(afterMessages);

  let headline: string;
  let tokenLine: string;
  if (noop) {
    headline = `No changes from compression: ${beforeCount} messages`;
    if (afterTokens === beforeTokens) {
      tokenLine = `Approx request size: ~${formatThousands(beforeTokens)} tokens (unchanged)`;
    } else {
      tokenLine = `Approx request size: ~${formatThousands(beforeTokens)} → ~${formatThousands(
        afterTokens,
      )} tokens`;
    }
  } else {
    headline = `Compressed: ${beforeCount} → ${afterCount} messages`;
    tokenLine = `Approx request size: ~${formatThousands(beforeTokens)} → ~${formatThousands(
      afterTokens,
    )} tokens`;
  }

  let note: string | null = null;
  if (!noop && afterCount < beforeCount && afterTokens > beforeTokens) {
    note =
      "Note: fewer messages can still raise this estimate when " +
      "compression rewrites the transcript into denser summaries.";
  }

  return { noop, headline, tokenLine, note };
}
