import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  ManagementEvents,
  managementRequest,
  UnknownOutcome,
  type PublicAICharacterView,
} from '@voxel/shared/management';

try {
  const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
  process.loadEnvFile?.(envPath);
} catch {
  // .env 文件为可选配置
}

const args = process.argv.slice(2);
function option(name: string) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) throw Error(`缺少 ${name} 参数`);
  args.splice(i, 2);
  return value;
}
let events: ManagementEvents | undefined;
try {
  // Accept the former WebSocket URL as well as the HTTP server base URL.
  const address = new URL(option('--url') ?? 'http://127.0.0.1:2567');
  address.protocol =
    address.protocol === 'wss:'
      ? 'https:'
      : address.protocol === 'ws:'
        ? 'http:'
        : address.protocol;
  if (!['http:', 'https:'].includes(address.protocol))
    throw Error('--url 需要 HTTP 或 WebSocket 地址。');
  address.pathname = address.pathname
    .replace(/\/ai-characters\/gateway\/?$/, '')
    .replace(/\/$/, '');
  address.search = '';
  address.hash = '';
  const baseUrl = address.toString().replace(/\/$/, '');
  const explicitTokenFile = option('--token-file');
  const tokenFile =
    explicitTokenFile ??
    process.env.AGENT_GATEWAY_TOKEN_FILE ??
    fileURLToPath(new URL('../../.data/agent-gateway-token', import.meta.url));
  const resolveToken = async () => {
    if (explicitTokenFile) {
      return (await readFile(explicitTokenFile, 'utf8')).trim();
    }
    const envToken = process.env.AGENT_GATEWAY_TOKEN?.trim();
    if (envToken) return envToken;
    try {
      const fileToken = (await readFile(tokenFile, 'utf8')).trim();
      if (fileToken) return fileToken;
    } catch {
      // ignore ENOENT
    }
    return '';
  };
  const goal = option('--goal');
  const characterId = option('--character') ?? option('--agent');
  const json = args.includes('--json');
  if (json) args.splice(args.indexOf('--json'), 1);
  const [command, id, third] = args;
  if (!command || command === 'help' || command === '--help') {
    console.log(
      '用法：agent:ctl list | status/join/stop <characterId> | plans [characterId] | watch [characterId] | runs <characterId> <planId> | task create <characterId> --goal ... | run pause/resume/cancel <runId> --character <characterId> | receipt <commandId> | auth show；选项 --url --token-file --json',
    );
  } else if (command === 'auth' && id === 'show') {
    const token = await resolveToken();
    if (token) {
      console.log(token);
    } else {
      console.log('未配置 AGENT_GATEWAY_TOKEN，Agent Gateway 当前处于免密访问模式。');
    }
  } else {
    const token = await resolveToken();
    const pending = new AbortController();
    const request = <T = unknown>(
      path: string,
      method = 'GET',
      body?: unknown,
    ) =>
      managementRequest<T>(baseUrl + path, {
        token,
        method,
        body,
        signal: pending.signal,
      });
    const print = (v: unknown) =>
      console.log(json ? JSON.stringify(v) : JSON.stringify(v, null, 2));
    const resource = (value?: string) => {
      if (!value) throw Error('缺少资源标识。');
      return encodeURIComponent(value);
    };
    if (command === 'watch') {
      events = new ManagementEvents({
        url: baseUrl.replace(/^http/, 'ws') + '/ai-characters/gateway',
        token: () => token,
        socket: (url) => new WebSocket(url),
      });
      let active = true,
        running = false,
        dirty = false;
      const refresh = async () => {
        dirty = true;
        if (running) return;
        running = true;
        try {
          while (active && dirty) {
            dirty = false;
            const data = await request(
              id ? `/ai-characters/${resource(id)}` : '/ai-characters',
            );
            if (active) print({ type: 'snapshot', data });
          }
        } catch {
          if (active) console.error('暂时无法刷新，等待下一次状态同步。');
        } finally {
          running = false;
        }
      };
      let finish!: () => void;
      const ended = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const stop = () => {
        active = false;
        pending.abort();
        events?.close();
        finish();
      };
      events.onEvent(() => {
        void refresh();
      });
      events.onState((state) => {
        if (state === 'unauthorized') {
          console.error('管理员令牌无效。');
          process.exitCode = 1;
          stop();
        } else if (state === 'disconnected')
          console.error('连接中断，托管任务继续运行；等待重连。');
      });
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        void events.connect().catch((error) => {
          if (active && events?.state === 'closed') {
            console.error(error.message);
            process.exitCode = 1;
            stop();
          }
        });
        await ended;
      } finally {
        stop();
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
    } else if (command === 'list') print(await request('/ai-characters'));
    else if (command === 'status')
      print(await request(`/ai-characters/${resource(id)}`));
    else if (command === 'join' || command === 'stop')
      print(
        await request(`/ai-characters/${resource(id)}/${command}`, 'POST', {}),
      );
    else if (command === 'plans')
      print(
        await request('/tasks' + (id ? `?characterId=${resource(id)}` : '')),
      );
    else if (command === 'runs')
      print(
        await request(
          `/tasks/${resource(third)}/runs?characterId=${resource(id)}`,
        ),
      );
    else if (command === 'receipt')
      print(await request(`/management/commands/${resource(id)}`));
    else if (command === 'task' && id === 'create') {
      if (!goal) throw Error('请通过 --goal 提供任务目标。');
      resource(third);
      print(
        await request('/tasks', 'POST', {
          characterId: third,
          name: goal.slice(0, 80),
          goal,
          timing: { kind: 'immediate' },
          timeZone: 'UTC',
        }),
      );
    } else if (
      command === 'run' &&
      ['pause', 'resume', 'cancel'].includes(id)
    ) {
      const view = await request<PublicAICharacterView>(
        `/ai-characters/${resource(characterId)}`,
      );
      print(
        await request(`/task-runs/${resource(third)}/${id}`, 'POST', {
          characterId,
          expectedTask: view.taskIdentity ?? null,
        }),
      );
    } else throw Error('不支持的命令。');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : '管理命令失败。');
  if (error instanceof UnknownOutcome)
    console.error(
      `可用 pnpm agent:ctl receipt ${error.commandId} 查询回执（使用相同 --url）。`,
    );
  process.exitCode = 1;
} finally {
  events?.close();
}
