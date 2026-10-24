import type { RequestAccounting } from './port';

/**
 * Conservative token estimate for a request that ends before the provider
 * reports usage. JSON length tracks the prompt payload closely enough, and
 * halving it stays above the real count for both CJK (~1 token per character)
 * and Latin text (~4 characters per token).
 */
export function estimateTokens(context: unknown, maxTokens: number): number {
  return Math.ceil(JSON.stringify(context).length / 2) + maxTokens;
}

/**
 * Charges exactly one budget entry per provider request.
 *
 * The budget is settled once, whether the provider reports usage, the stream
 * fails, or the caller aborts; a request admitted but never settled is charged
 * the estimate so an abandoned call cannot hide its cost.
 */
export class RequestCharge {
  private admitted = false;
  private settled = false;

  constructor(
    private readonly budget: RequestAccounting,
    private readonly estimate: number,
  ) {}

  /** Reserves the call and returns the token cap for this response. */
  begin(): number {
    const maxTokens = this.budget.begin();
    this.admitted = true;
    return maxTokens;
  }

  /** Records reported usage once; later settlements (such as the catch path) are ignored. */
  settleUsage(totalTokens: number): void {
    const known = totalTokens > 0;
    this.settle(known ? totalTokens : this.estimate, !known);
  }

  /** Charges the estimate for a request whose usage was never reported. */
  settleUnknown(): void {
    if (this.admitted) this.settle(this.estimate, true);
  }

  private settle(tokens: number, estimated: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.budget.finish(tokens, estimated);
  }
}
