import { runtimeView } from '@voxel/agent-runtime';

import type { AICharacterView } from '@voxel/shared';
import type { AICharacterRegistry } from '../services/character-job';
import { characterSettings, type CharacterRecord } from './record';

/** Character snapshots and failure handling; no file writes or task-ledger ownership. */
export class CharacterSnapshots {
  private committed = new Map<string, CharacterRecord>();
  publicIdentity(id: string) {
    const runtime = this.committed.get(id)?.runtime;
    return runtime ? runtimeView(runtime).identity : undefined;
  }

  committedCharacterName(id: string): string | undefined {
    return this.committed.get(id)?.name;
  }

  commit(records: CharacterRecord[]) {
    this.committed = new Map(records.map((record) => [record.id, record]));
  }

  capture(
    jobs: AICharacterRegistry,
    list: () => AICharacterView[],
    shutdownPresence: Map<string, AICharacterView['status']>,
  ) {
    const views = list();
    const records = [...views].reverse().map((view) => ({
      ...characterSettings(view),
      id: view.id,
      createdAt: view.createdAt,
      logEntries: view.logEntries,
      status: shutdownPresence.get(view.id) ?? view.status,
      runtime: jobs.get(view.id)?.runtime.snapshot(),
      currentRunId: jobs.get(view.id)?.currentRunId,
    }));
    return { records, views };
  }

  reject(
    records: CharacterRecord[],
    jobs: AICharacterRegistry,
    affected: Set<string | undefined>,
    cancel: (id: string) => void,
  ) {
    for (const record of records) {
      if (
        !affected.has(record.id) &&
        JSON.stringify(this.committed.get(record.id)) === JSON.stringify(record)
      )
        continue;
      const job = jobs.get(record.id);
      if (job) {
        job.storageFailed = true;
        job.abort.abort();
        cancel(record.id);
      }
    }
  }
}
