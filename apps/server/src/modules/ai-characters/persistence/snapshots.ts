import { runtimeView } from '@voxel/agent-runtime';

import type { AICharacterView } from '@voxel/shared';
import type { AICharacterRegistry } from '../services/job';
import type { CharacterRecord } from './record';

/** Character snapshots and failure handling; no file writes or task-ledger ownership. */
export class CharacterSnapshots {
  private committed = new Map<string, CharacterRecord>();
  private committedViews: AICharacterView[] = [];

  publicList(): AICharacterView[] {
    return structuredClone(this.committedViews);
  }

  publicIdentity(id: string) {
    const snapshot = this.committed.get(id)?.runtime;
    return snapshot ? runtimeView(snapshot).identity : undefined;
  }

  publicLogEntries(id: string) {
    return structuredClone(this.committed.get(id)?.logEntries ?? []);
  }

  committedCharacterName(id: string): string | undefined {
    return this.committed.get(id)?.name;
  }

  commit(records: CharacterRecord[], views: AICharacterView[]) {
    this.committed = new Map(records.map((record) => [record.id, record]));
    this.committedViews = views;
  }

  capture(
    jobs: AICharacterRegistry,
    list: () => AICharacterView[],
    shutdownPresence: Map<string, AICharacterView['status']>,
  ) {
    const views = list();
    const records = [...views].reverse().map((view) => ({
      ...view,
      status: shutdownPresence.get(view.id) ?? view.status,
      sessionId: undefined,
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
