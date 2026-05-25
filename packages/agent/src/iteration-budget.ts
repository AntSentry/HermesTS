/**
 * Per-agent iteration budget — consume/refund counter.
 *
 * Faithful port of upstream `agent/iteration_budget.py`.
 *
 * Each `AIAgent` instance (parent or subagent) holds an `IterationBudget`;
 * the parent's cap comes from `max_iterations` (default 90), each subagent's
 * cap comes from `delegation.max_iterations` (default 50). `execute_code`
 * (programmatic tool calling) iterations are refunded via `refund()` so they
 * don't eat into the budget.
 *
 * Faithful divergence:
 *   - Upstream uses `threading.Lock` to make consume/refund safe across
 *     Python threads. Node's event loop is single-threaded, and these
 *     methods are synchronous (no `await` between read-modify-write), so
 *     the lock is unnecessary and is dropped. The thread-safety contract
 *     against `asyncio` re-entrancy is preserved by the synchronous shape.
 */

export class IterationBudget {
  readonly maxTotal: number;
  private _used = 0;

  constructor(maxTotal: number) {
    this.maxTotal = maxTotal;
  }

  /** Try to consume one iteration. Returns `true` if allowed. */
  consume(): boolean {
    if (this._used >= this.maxTotal) {
      return false;
    }
    this._used += 1;
    return true;
  }

  /** Give back one iteration (e.g. for `execute_code` turns). */
  refund(): void {
    if (this._used > 0) {
      this._used -= 1;
    }
  }

  get used(): number {
    return this._used;
  }

  get remaining(): number {
    return Math.max(0, this.maxTotal - this._used);
  }
}
