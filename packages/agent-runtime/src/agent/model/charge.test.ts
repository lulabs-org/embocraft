import { describe, expect, it } from 'vitest';
import { estimateTokens, RequestCharge, type RequestAccounting } from './charge';

function fakeBudget(cap = () => 256) {
  const finishes: { tokens: number; estimated: boolean }[] = [];
  const budget: RequestAccounting = {
    usage: { calls: 0, tokens: 0, estimated: false },
    remainingMs: 10_000,
    check: () => {},
    begin() {
      this.usage.calls += 1;
      return cap();
    },
    finish(tokens, estimated) {
      finishes.push({ tokens, estimated });
      this.usage.tokens += tokens;
      this.usage.estimated ||= estimated;
    },
  };
  return { budget, finishes };
}

describe('request charge', () => {
  it('settles reported usage exactly once', () => {
    const { budget, finishes } = fakeBudget();
    const charge = new RequestCharge(budget, 999);
    expect(charge.begin()).toBe(256);
    charge.settleUsage(120);
    charge.settleUsage(500);
    charge.settleUnknown();
    expect(finishes).toEqual([{ tokens: 120, estimated: false }]);
    expect(budget.usage.calls).toBe(1);
  });

  it('estimates usage when the provider reports none', () => {
    const { budget, finishes } = fakeBudget();
    const charge = new RequestCharge(budget, 700);
    charge.begin();
    charge.settleUsage(0);
    expect(finishes).toEqual([{ tokens: 700, estimated: true }]);
  });

  it('charges the estimate when the request throws before reporting usage', () => {
    const { budget, finishes } = fakeBudget();
    const charge = new RequestCharge(budget, 700);
    charge.begin();
    charge.settleUnknown();
    expect(finishes).toEqual([{ tokens: 700, estimated: true }]);
  });

  it('does not charge a request that was never admitted', () => {
    const { budget, finishes } = fakeBudget();
    new RequestCharge(budget, 700).settleUnknown();
    expect(finishes).toEqual([]);
  });

  it('estimates tokens from the context payload plus the token cap', () => {
    const context = { messages: [{ role: 'user', content: '你好，world' }] };
    const expected = Math.ceil(JSON.stringify(context).length / 2) + 512;
    expect(estimateTokens(context, 512)).toBe(expected);
    expect(estimateTokens(context, 512)).toBeGreaterThan(512);
  });
});
