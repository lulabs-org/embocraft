import {
  MANAGEMENT_EVENTS_VERSION,
  ManagementError,
  type ManagementEvent,
  type ManagementFrame,
  type CommandReceipt,
} from './contracts';
export type SocketLike = {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: string,
    listener: (event: { type: string; data?: unknown }) => void,
  ): void;
};
export type ClientState =
  | 'closed'
  | 'connecting'
  | 'connected'
  | 'unauthorized'
  | 'disconnected';

/** Browser and command-line event subscription; no RPC or write replay. */
export class ManagementEvents {
  private socket?: SocketLike;
  private stopped = true;
  private timer?: ReturnType<typeof setTimeout>;
  private retry = 0;
  private pending?: Promise<void>;
  private reject?: (error: Error) => void;
  private listeners = new Set<(event: ManagementEvent) => void>();
  private states = new Set<(state: ClientState) => void>();
  state: ClientState = 'closed';
  constructor(
    private options: {
      url: string;
      token: () => string;
      socket: (url: string) => SocketLike;
      reconnect?: boolean;
    },
  ) {}
  onState(fn: (state: ClientState) => void) {
    this.states.add(fn);
    return () => {
      this.states.delete(fn);
    };
  }
  onEvent(fn: (event: ManagementEvent) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private setState(state: ClientState) {
    this.state = state;
    for (const fn of this.states) fn(state);
  }
  connect(): Promise<void> {
    if (this.state === 'connected') return Promise.resolve();
    if (this.pending) return this.pending;
    this.stopped = false;
    clearTimeout(this.timer);
    this.setState('connecting');
    let resolve!: () => void;
    const result = (this.pending = new Promise<void>((yes, no) => {
      resolve = yes;
      this.reject = no;
    }));
    let socket: SocketLike;
    try {
      this.socket = socket = this.options.socket(this.options.url);
    } catch {
      this.disconnected();
      return result;
    }
    let seq = 0;
    const handshake = setTimeout(() => socket.close(), 6000);
    socket.addEventListener('open', () => {
      if (this.socket === socket)
        socket.send(
          JSON.stringify({
            type: 'connect',
            version: MANAGEMENT_EVENTS_VERSION,
            token: this.options.token(),
          }),
        );
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      try {
        const frame: ManagementFrame = JSON.parse(String(event.data));
        if (frame.type === 'connected') {
          if (frame.version !== MANAGEMENT_EVENTS_VERSION) {
            this.reject?.(
              new Error('管理协议版本不兼容，请同步更新客户端和服务器。'),
            );
            this.close();
            return;
          }
          clearTimeout(handshake);
          this.retry = 0;
          this.pending = undefined;
          this.reject = undefined;
          this.setState('connected');
          resolve();
        } else if (frame.type === 'error') {
          this.reject?.(
            new ManagementError(
              frame.error.message,
              frame.error.code,
              frame.error.status,
            ),
          );
          if (frame.error.status === 401 || frame.error.status === 403) {
            this.stopped = true;
            this.setState('unauthorized');
          }
          socket.close();
        } else if (frame.type === 'event') {
          if (this.state !== 'connected' || frame.seq !== seq + 1) {
            socket.close();
            return;
          }
          seq = frame.seq;
          for (const fn of this.listeners) fn(frame);
        } else socket.close();
      } catch {
        socket.close();
      }
    });
    socket.addEventListener('error', () => {});
    socket.addEventListener('close', () => {
      clearTimeout(handshake);
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.disconnected();
    });
    return result;
  }
  private disconnected() {
    this.reject?.(new Error('管理通知连接已断开。'));
    this.reject = undefined;
    this.pending = undefined;
    if (this.state !== 'unauthorized')
      this.setState(this.stopped ? 'closed' : 'disconnected');
    if (!this.stopped && this.options.reconnect !== false)
      this.timer = setTimeout(
        () => {
          void this.connect().catch(() => {});
        },
        Math.min(10000, 500 * 2 ** this.retry++),
      );
  }
  close() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.close();
    if (!this.socket) this.disconnected();
  }
}
export class UnknownOutcome extends Error {
  constructor(readonly commandId: string) {
    super(
      `操作结果待确认（命令 ${commandId}），请同步当前状态或查询命令回执后再决定是否重试。`,
    );
  }
}
export async function managementRequest<T>(
  url: string,
  options: {
    token: string;
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    headers?: Record<string, string>;
    commandId?: string;
  },
): Promise<T> {
  const method = options.method ?? 'GET';
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const commandId = write
    ? (options.commandId ??
      options.headers?.['Idempotency-Key'] ??
      crypto.randomUUID())
    : undefined;
  options.signal?.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${options.token}`,
        ...(options.body !== undefined
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...options.headers,
        ...(commandId ? { 'Idempotency-Key': commandId } : {}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.any([
        AbortSignal.timeout(30000),
        ...(options.signal ? [options.signal] : []),
      ]),
    });
  } catch (error) {
    if (commandId) throw new UnknownOutcome(commandId);
    throw error;
  }
  if (response.status === 204) return undefined as T;
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    if (commandId) throw new UnknownOutcome(commandId);
    throw new Error(`管理服务响应异常（HTTP ${response.status}）。`);
  }
  if (!response.ok)
    throw new ManagementError(
      data &&
      typeof data === 'object' &&
      'error' in data &&
      typeof data.error === 'string'
        ? data.error
        : '管理请求失败。',
      'HTTP_ERROR',
      response.status,
    );
  return data as T;
}
export const commandReceipt = (baseUrl: string, token: string, id: string) =>
  managementRequest<CommandReceipt>(
    `${baseUrl}/console-sync/commands/${encodeURIComponent(id)}`,
    { token },
  );
