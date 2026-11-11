import { AppError } from '../../../core/errors/app-error';
import type { CharacterReadPort } from '../ports';
import type { PlanService } from '../../tasks';
import { restoreTaskMemory } from '../../tasks';
import { restoreAICharacterLogs } from '../domain/activity-log';
import {
  createCharacterJob,
  type AICharacterRegistry,
  type Job,
} from '../runtime/character-registry';

/** Offline state exists only for the duration of a command, never in the online registry. */
export class CharacterOperations {
  readonly pending = new Map<string, Job>();
  private readonly locked = new Set<string>();

  constructor(
    private readonly jobs: AICharacterRegistry,
    private readonly queries: CharacterReadPort,
    private readonly plans: () => PlanService,
    private readonly release: (job: Job) => void,
  ) {}

  get(id: string) {
    return this.jobs.get(id) ?? this.pending.get(id);
  }

  async run<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.locked.has(id))
      throw new AppError('角色状态正在更新，请稍候。', 409);
    this.locked.add(id);
    let job = this.jobs.get(id);
    try {
      if (!job) {
        const record = await this.queries.record(id);
        const { runtime, currentRunId, ...view } = record;
        job = createCharacterJob(
          {
            view: {
              ...view,
              ...restoreAICharacterLogs(view.logEntries),
              providerName: view.providerId,
            },
            currentRunId,
            abort: new AbortController(),
            ledger: this.plans(),
          },
          restoreTaskMemory(runtime),
        );
      }
      this.pending.set(id, job);
      return await action();
    } finally {
      this.pending.delete(id);
      this.locked.delete(id);
      if (job) this.release(job);
    }
  }
}
