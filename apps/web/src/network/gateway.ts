import {
  ManagementEvents,
  commandReceipt,
  type UnknownOutcome,
} from '@voxel/shared/management';
import { serverSocketUrl, gatewaySocketUrl, serverHttpUrl } from './endpoints';
let client: ManagementEvents | undefined;
let state = 'closed';
let failure = '';
type Change = {
  resource?: 'characters' | 'providers' | 'plans' | 'runs';
  characterIds?: string[];
};
const listeners = new Set<() => void>(),
  changes = new Set<(change: Change) => void>();
const notify = () => {
  for (const fn of listeners) fn();
};
const tokenKey = () => `agent-gateway-token:${serverSocketUrl()}`;
export const getGatewayToken = () => {
  try {
    return sessionStorage.getItem(tokenKey()) ?? '';
  } catch {
    return '';
  }
};
export function saveGatewayToken(token: string) {
  failure = '';
  sessionStorage.setItem(tokenKey(), token.trim());
  closeGateway();
  openGateway();
}
export function clearGatewayToken() {
  sessionStorage.removeItem(tokenKey());
  closeGateway();
  failure = '';
  notify();
}
export const adminHeaders = () => ({
  Authorization: `Bearer ${getGatewayToken()}`,
});
export const gatewayState = () => state;
export const gatewayError = () => failure;
export function onGatewayState(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function onGatewayChange(fn: (change: Change) => void) {
  changes.add(fn);
  return () => {
    changes.delete(fn);
  };
}
const uncertain = new Set<string>();
let reconciling = false;
export function reportUnknownOutcome(error: UnknownOutcome) {
  uncertain.add(error.commandId);
  failure = error.message;
  notify();
  void reconcileOutcomes();
}
async function reconcileOutcomes() {
  if (reconciling || !getGatewayToken()) return;
  reconciling = true;
  const owner = client;
  try {
    for (const id of uncertain) {
      try {
        const receipt = await commandReceipt(
          serverHttpUrl(),
          getGatewayToken(),
          id,
        );
        if (client !== owner) return;
        if (receipt.state !== 'pending') uncertain.delete(id);
        failure =
          receipt.state === 'committed'
            ? '先前的操作已提交，请以当前状态为准。'
            : receipt.state === 'rejected'
              ? '先前的操作被拒绝，请检查当前状态后重试。'
              : '先前的操作结果待确认，请根据当前状态决定下一步。';
        notify();
      } catch {
        /* Retry on the next connection or change notification. */
      }
    }
  } finally {
    reconciling = false;
  }
}
export function openGateway() {
  if (client || !getGatewayToken()) return;
  const c = new ManagementEvents({
    url: gatewaySocketUrl(),
    token: getGatewayToken,
    socket: (url) => new WebSocket(url),
  });
  client = c;
  c.onState((s) => {
    if (client !== c) return;
    state = s === 'connected' ? 'syncing' : s;
    notify();
  });
  c.onEvent((e) => {
    if (client !== c) return;
    if (e.event === 'snapshot') {
      if (!uncertain.size) failure = '';
      state = 'ready';
      notify();
    }
    void reconcileOutcomes();
    for (const fn of changes)
      fn(e.event === 'changed' ? (e.data as Change) : {});
  });
  void c.connect().catch((e) => {
    if (client === c) {
      failure = e.message;
      notify();
    }
  });
}
export function closeGateway() {
  const c = client;
  client = undefined;
  c?.close();
  uncertain.clear();
  state = 'closed';
  notify();
}
/** Coalesce event-triggered reads without polling or losing a change during an active read. */
export function refreshOnGatewayChange(
  read: () => Promise<void>,
  filter: {
    resource: 'characters' | 'providers' | 'plans' | 'runs';
    characterId?: string;
  } = {
    resource: 'characters',
  },
) {
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
        await read();
      }
    } finally {
      running = false;
    }
  };
  const off = onGatewayChange((change) => {
    if (
      change.resource &&
      change.resource !== filter.resource &&
      !(
        filter.resource === 'plans' &&
        ['runs', 'characters'].includes(change.resource)
      )
    )
      return;
    if (
      filter.characterId &&
      change.characterIds &&
      !change.characterIds.includes(filter.characterId)
    )
      return;
    void refresh();
  });
  void refresh();
  return () => {
    active = false;
    off();
  };
}
