import type {
  ArchivePort,
  CharacterRecord,
  ManagementArchive,
} from '../persistence/management-archive';
import {
  ManagementPersistence,
  type ManagementSnapshotPorts,
} from './management-commit';

type Participants<Characters, Tasks> = Omit<
  ManagementSnapshotPorts<Characters, Tasks>,
  'rejectCharacters'
> & {
  affectedCharacters(
    records: CharacterRecord[],
    affected: Set<string | undefined>,
  ): string[];
  protectCharacters(ids: string[]): void;
  publishCommitted(snapshot: ManagementArchive, views: { id: string }[]): void;
};

/** Connects snapshot participants to one serialized commit and notification boundary. */
export function createManagementPersistence<Characters, Tasks>(
  archive: ArchivePort,
  participants: Participants<Characters, Tasks>,
) {
  return new ManagementPersistence(
    archive,
    (snapshot, views) => {
      const publicViews = new Map(views.map((view) => [view.id, view]));
      participants.publishCommitted(
        snapshot,
        snapshot.characters.map((record) => ({
          ...publicViews.get(record.id),
          ...record,
          sessionId: undefined,
        })),
      );
    },
    {
      ...participants,
      rejectCharacters: (records, affected) =>
        participants.protectCharacters(
          participants.affectedCharacters(records, affected),
        ),
    },
  );
}
