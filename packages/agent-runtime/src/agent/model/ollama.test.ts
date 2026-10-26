import { expect, it, vi } from 'vitest';
import { ollamaCompletion } from './ollama';

const payload = {
  model: 'qwen3:8b',
  max_tokens: 512,
  stream: true,
  messages: [
    { role: 'system', content: 'Use tools.' },
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-1',
          function: { name: 'goto', arguments: '{"x":2,"y":2.5,"z":0}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'arrived' },
  ],
  tools: [
    {
      type: 'function',
      function: { name: 'complete_task', parameters: { type: 'object' } },
    },
  ],
};
const response = (overrides: object = {}) =>
  new Response(
    JSON.stringify({
      done: true,
      done_reason: 'stop',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            function: {
              name: 'complete_task',
              arguments: { summary: 'arrived' },
            },
          },
        ],
      },
      prompt_eval_count: 100,
      eval_count: 20,
      ...overrides,
    }),
  );

it('sets native context and thinking, replays named tool results, and preserves actual usage', async () => {
  const request = vi.fn<typeof fetch>(async () => response());
  const signal = new AbortController().signal;
  const res = await ollamaCompletion(
    'http://localhost:11434/v1/chat/completions',
    {
      body: JSON.stringify(payload),
      signal,
      headers: { Authorization: 'Bearer local' },
    },
    request,
    32768,
    false,
  );
  const [url, init] = request.mock.calls[0];
  expect(String(url)).toBe('http://localhost:11434/api/chat');
  expect(init?.signal).toBe(signal);
  expect(init?.redirect).toBe('error');
  const body = JSON.parse(String(init?.body));
  expect(body).toMatchObject({
    think: false,
    stream: false,
    options: { num_ctx: 32768, num_predict: 512 },
  });
  expect(body.messages[1].content).toBe('hello');
  expect(body.messages[2].tool_calls[0].function.arguments).toEqual({
    x: 2,
    y: 2.5,
    z: 0,
  });
  expect(body.messages[3]).toMatchObject({
    role: 'tool',
    tool_name: 'goto',
    content: 'arrived',
  });
  const events = (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data: {'))
    .map((l) => JSON.parse(l.slice(6)));
  expect(events[0].choices[0].delta.tool_calls[0].function).toEqual({
    name: 'complete_task',
    arguments: '{"summary":"arrived"}',
  });
  expect(events[1]).toMatchObject({
    choices: [{ finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  });
});
it('keeps truncated tool output marked length so the executor rejects the entire batch', async () => {
  const request = vi.fn<typeof fetch>(async () =>
    response({ done_reason: 'length' }),
  );
  const result = await ollamaCompletion(
    'http://localhost:11434/v1/chat/completions',
    { body: JSON.stringify(payload) },
    request,
    32768,
    false,
  );
  expect(await result.text()).toContain('"finish_reason":"length"');
  expect(request).toHaveBeenCalledTimes(1);
});
it('rejects incomplete responses and does not retry or fabricate tool calls', async () => {
  const request = vi.fn<typeof fetch>(async () => response({ done: false }));
  await expect(
    ollamaCompletion(
      'http://localhost:11434/v1/chat/completions',
      { body: JSON.stringify(payload) },
      request,
      32768,
      false,
    ),
  ).rejects.toThrow('Incomplete');
  expect(request).toHaveBeenCalledTimes(1);
});
it('returns upstream failures for the existing redacted HTTP error handling', async () => {
  const failure = new Response('private upstream error', { status: 503 });
  const request = vi.fn<typeof fetch>(async () => failure);
  expect(
    await ollamaCompletion(
      'http://localhost:11434/v1/chat/completions',
      { body: JSON.stringify(payload) },
      request,
      32768,
      false,
    ),
  ).toBe(failure);
  expect(request).toHaveBeenCalledTimes(1);
});
