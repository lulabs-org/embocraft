import { describe, expect, it } from 'vitest';
import { env } from './env';

describe('gateway token configuration', () => {
  it('allows an empty token in development and requires one in production', () => {
    expect(env.readServer({}).gateway.token).toBeUndefined();
    expect(() =>
      env.readServer({ NODE_ENV: 'production', AGENT_GATEWAY_TOKEN: '   ' }),
    ).toThrow('生产环境必须配置 AGENT_GATEWAY_TOKEN');
  });

  it('trims the token and accepts both length limits', () => {
    for (const length of [24, 4096]) {
      const token = 'x'.repeat(length);
      const config = env.readServer({
        NODE_ENV: 'production',
        AGENT_GATEWAY_TOKEN: ` ${token}\n`,
      });
      expect(config.gateway.token).toBe(token);
    }
  });

  it('rejects out-of-range lengths and embedded whitespace', () => {
    for (const token of [
      'x'.repeat(23),
      'x'.repeat(4097),
      'abc def'.repeat(4),
    ]) {
      expect(() => env.readServer({ AGENT_GATEWAY_TOKEN: token })).toThrow(
        'AGENT_GATEWAY_TOKEN 需为 24–4096 个无空白字符',
      );
    }
  });
});
