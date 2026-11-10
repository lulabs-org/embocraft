import { runtimeView } from '@voxel/agent-runtime';

import type { AICharacterView } from '@voxel/shared';
import type { AICharacterRegistry } from '../runtime/character-registry';
import { characterSettings, type CharacterRecord } from './character-record';

/** Captures and tracks the last committed character runtime snapshots. */
export class CharacterSnapshots {
  private committed = new Map<string, CharacterRecord>();
  forget(id: string) {
    this.committed.delete(id);
  }

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

  affectedByFailure(
    records: CharacterRecord[],
    affected: Set<string | undefined>,
  ): string[] {
    return records
      .filter(
        (record) =>
          affected.has(record.id) ||
          JSON.stringify(this.committed.get(record.id)) !==
            JSON.stringify(record),
      )
      .map((record) => record.id);
  }
}
