import type {
  AgentConfig,
  AgentRunner,
  Session,
  TaskLease,
} from '@voxel/agent-runtime';
import type { WorldEvent } from '@voxel/shared';
import type { Job } from './job';
import type { VoiceServicePort as VoiceServiceStore } from '../ports';
import type { SavedProvider } from '../../providers';

/** AI 角色在游戏世界中的会话运行时执行上下文契约 */
export type ExecutionContext = {
  serverUrl: string;
  dependencies: {
    session: (url: string) => Session;
    runner: (
      config: AgentConfig,
      provider: SavedProvider,
    ) => Pick<AgentRunner, 'run'>;
  };
  voiceServices?: VoiceServiceStore;
  closing: () => boolean;
  bindVoice: (job: Job) => void;
  controlMessage: (
    id: string,
    op: 'pause' | 'cancel',
    identity: TaskLease,
    commandId: string,
    message: WorldEvent,
  ) => Promise<unknown>;
  wake: (job: Job) => void;
  schedule: (job: Job) => void;
  save: () => Promise<void>;
  persist: () => void;
};
