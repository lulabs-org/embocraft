import { describe, expect, it } from 'vitest';
import { agentConfig } from './config';

describe('CLI command-line configuration', () => {
  it('requires credentials and bounds the inference budget', () => {
    expect(() => agentConfig({})).toThrow('--api-key');
    expect(agentConfig({ 'api-key': 'fixture' })).toMatchObject({
      model: 'deepseek-flash',
      maxTurns: 100,
      allowEdits: false,
    });
    for (const env of [
      { 'max-turns': '0' },
      { 'max-turns': '1001' },
      { 'interval-ms': '10' },
      { 'allow-edits': 'yes' },
    ])
      expect(() => agentConfig({ 'api-key': 'key', ...env })).toThrow();
  });
  it('supports explicit CLI scheduling settings while preserving finite defaults', () => {
    expect(agentConfig({ 'api-key': 'fixture' })).toMatchObject({
      continuous: false,
      intervalMode: 'fixed',
    });
    expect(
      agentConfig({
        'api-key': 'fixture',
        continuous: 'true',
        'interval-mode': 'random',
        'interval-min-ms': '4000',
        'interval-max-ms': '8000',
      }),
    ).toMatchObject({
      continuous: true,
      intervalMode: 'random',
      intervalMinMs: 4000,
      intervalMaxMs: 8000,
    });
    for (const env of [
      { continuous: 'yes' },
      { 'interval-mode': 'bad' },
      { 'interval-min-ms': '9000', 'interval-max-ms': '4000' },
      { 'interval-min-ms': '0' },
    ])
      expect(() => agentConfig({ 'api-key': 'fixture', ...env })).toThrow();
  });
  it('supports explicit inference options', () => {
    expect(
      agentConfig({
        'api-key': ' key ',
        model: 'custom-model',
        thinking: 'enabled',
        'max-tokens': '1024',
        'timeout-ms': '5000',
      }),
    ).toMatchObject({
      apiKey: 'key',
      model: 'custom-model',
      thinking: 'enabled',
      maxTokens: 1024,
      timeoutMs: 5000,
    });
  });
});
