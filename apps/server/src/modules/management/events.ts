type EventSnapshot = {
  plans: { id: string }[];
  runs: { id: string; planId?: string; source?: string }[];
};

export type ManagementResourceChange = {
  resource: 'characters' | 'providers' | 'plans' | 'runs';
  planIds?: string[];
  runIds?: string[];
  characterIds: string[];
  version: number;
};

export class ManagementEvents {
  private listeners = new Set<(change: ManagementResourceChange) => void>();
  private previous = new Map<string, string>();
  private planState = new Map<string, string>();
  private runState = new Map<string, string>();
  version = 0;

  on(listener: (change: ManagementResourceChange) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  commit(records: { id: string }[], archive?: EventSnapshot) {
    const next = new Map(records.map((r) => [r.id, JSON.stringify(r)]));
    const ids = [...new Set([...next.keys(), ...this.previous.keys()])].filter(
      (id) => next.get(id) !== this.previous.get(id),
    );
    this.previous = next;
    if (ids.length) this.publish('characters', ids);
    if (archive) {
      const diff = (
        values: { id: string }[],
        previous: Map<string, string>,
      ) => {
        const next = new Map(values.map((v) => [v.id, JSON.stringify(v)]));
        const ids = [...new Set([...next.keys(), ...previous.keys()])].filter(
          (id) => next.get(id) !== previous.get(id),
        );
        previous.clear();
        for (const [id, v] of next) previous.set(id, v);
        return ids;
      };
      const planIds = diff(archive.plans, this.planState),
        runIds = diff(archive.runs, this.runState);
      if (planIds.length) this.publish('plans', [], { planIds });
      if (runIds.length)
        this.publish('runs', [], {
          runIds,
          planIds: [
            ...new Set(
              archive.runs
                .filter(
                  (r) =>
                    runIds.includes(r.id) && r.planId && r.source !== 'chat',
                )
                .map((r) => r.planId!),
            ),
          ],
        });
    }
  }

  publish(
    resource: ManagementResourceChange['resource'],
    characterIds: string[] = [],
    details: { planIds?: string[]; runIds?: string[] } = {},
  ) {
    const c: ManagementResourceChange = {
      resource,
      characterIds,
      ...details,
      version: ++this.version,
    };
    for (const listener of this.listeners) {
      try {
        listener(c);
      } catch {
        /* A subscriber cannot fail a committed write. */
      }
    }
  }

  close() {
    this.listeners.clear();
  }
}
