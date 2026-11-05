import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);
const script = fileURLToPath(new URL('./agent-control.ts', import.meta.url));

function showToken(token: string, ...options: string[]) {
  return run(
    process.execPath,
    ['--import', 'tsx', script, 'auth', 'show', ...options],
    { env: { ...process.env, AGENT_GATEWAY_TOKEN: token } },
  );
}

it('shows the configured CLI token and reports when it is empty', async () => {
  const configured = await showToken('  fixture-token-from-env  ');
  expect(configured.stdout.trim()).toBe('fixture-token-from-env');
  const empty = await showToken('');
  expect(empty.stdout.trim()).toBe('本地未设置 AGENT_GATEWAY_TOKEN。');
});

it('rejects unsupported options before using the configured token', async () => {
  await expect(
    showToken('fixture-token-from-env', '--unknown'),
  ).rejects.toMatchObject({
    code: 1,
    stdout: '',
    stderr: expect.stringContaining('不支持的选项 --unknown'),
  });
});
