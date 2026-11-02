import { ManagementEvents, managementRequest } from '@voxel/shared/management';

/** Test-only vocabulary adapter, preserving the end-to-end scenarios while exercising HTTP routes. */
export class HttpManagementProbe {
  constructor(
    private url: string,
    private token: string,
    private events: ManagementEvents,
  ) {}
  connect() {
    return this.events.connect();
  }
  close() {
    this.events.close();
  }
  onEvent(fn: Parameters<ManagementEvents['onEvent']>[0]) {
    return this.events.onEvent(fn);
  }
  async subscribe(_params: unknown = {}) {
    await this.connect();
    return () => {};
  }
  async request<T = unknown>(
    method: string,
    p: {
      characterId?: string;
      planId?: string;
      runId?: string;
      commandId?: string;
      targetCharacterId?: string;
      operation?: string;
      value?: Record<string, unknown>;
      expectedPlanRevision?: number;
      expectedTask?: unknown;
      offset?: number;
      search?: string;
      state?: string;
    } = {},
    options: { commandId?: string } = {},
  ): Promise<T> {
    const enc = (value: string | undefined) =>
      encodeURIComponent(String(value));
    const query = (value: object) => {
      const q = new URLSearchParams(
        Object.entries(value)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      );
      return q.size ? '?' + q : '';
    };
    let path: string,
      verb = 'GET',
      body: unknown;
    switch (method) {
      case 'characters.list':
        path = '/ai-characters';
        break;
      case 'characters.get':
        path = '/ai-characters/' + enc(p.characterId);
        break;
      case 'characters.create':
        path = '/ai-characters';
        verb = 'POST';
        body = p.value;
        break;
      case 'characters.update':
        path = '/ai-characters/' + enc(p.characterId);
        verb = 'PUT';
        body = p.value;
        break;
      case 'characters.delete':
        path = '/ai-characters/' + enc(p.characterId);
        verb = 'DELETE';
        break;
      case 'characters.join':
      case 'characters.stop':
      case 'characters.voice':
        path = `/ai-characters/${enc(p.characterId)}/${method.split('.')[1]}`;
        verb = 'POST';
        body = p.value ?? {};
        break;
      case 'plans.list':
        path = '/tasks' + query(p);
        break;
      case 'plans.get':
        path = '/tasks/' + enc(p.planId);
        break;
      case 'plans.create':
        path = '/tasks';
        verb = 'POST';
        body = { ...p.value, characterId: p.characterId };
        break;
      case 'plans.update':
        path = '/tasks/' + enc(p.planId);
        verb = 'PUT';
        body = {
          ...p.value,
          characterId: p.characterId,
          expectedPlanRevision: p.expectedPlanRevision,
        };
        break;
      case 'plans.reassign':
        path = `/tasks/${enc(p.planId)}/reassign`;
        verb = 'POST';
        body = {
          targetCharacterId: p.targetCharacterId,
          expectedPlanRevision: p.expectedPlanRevision,
        };
        break;
      case 'plans.control':
        path = `/tasks/${enc(p.planId)}/${enc(p.operation)}`;
        verb = 'POST';
        body = {
          ...p.value,
          characterId: p.characterId,
          expectedPlanRevision: p.expectedPlanRevision,
          expectedTask: p.expectedTask,
        };
        break;
      case 'runs.list':
        path =
          `/tasks/${enc(p.planId)}/runs` +
          query({ characterId: p.characterId, offset: p.offset });
        break;
      case 'runs.control':
        path = `/task-runs/${enc(p.runId)}/${enc(p.operation)}`;
        verb = 'POST';
        body = {
          ...p.value,
          characterId: p.characterId,
          expectedTask: p.expectedTask,
        };
        break;
      case 'commands.get':
        path = '/console-sync/commands/' + enc(p.commandId);
        break;
      case 'providers.list':
        path = '/providers';
        break;
      default:
        throw Error('Unsupported management operation');
    }
    return managementRequest<T>(this.url + path, {
      token: this.token,
      method: verb,
      body,
      commandId: options.commandId,
    });
  }
}
