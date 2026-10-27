import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { AppError } from '../core/errors/app-error';
import type {
  CharacterRecord,
  ManagementArchive,
  LegacyAgentArchive,
} from './archive';
import { migrateArchive } from './migrate-archive';

export async function writeManagementArchive(
  archivePath: string,
  records: ManagementArchive,
): Promise<void> {
  const data = JSON.stringify(records, null, 2);
  const temp = `${archivePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data, { mode: 0o600, flag: 'wx' });
    await rename(temp, archivePath);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

export async function readManagementArchive(
  archivePath: string,
): Promise<ManagementArchive | undefined> {
  let saved: CharacterRecord[] | LegacyAgentArchive | ManagementArchive;
  try {
    saved = JSON.parse(await readFile(archivePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw new AppError('无法读取 Agent 记录。', 500);
  }
  const migrated = migrateArchive(saved);
  if (Array.isArray(saved) || saved.version < 3) {
    await writeFile(
      `${archivePath}.before-character-events-v3.bak`,
      await readFile(archivePath),
      { mode: 0o600, flag: 'wx' },
    ).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
  }
  if (!Array.isArray(saved)) return migrated;

  if (saved.length > 50) {
    throw new AppError('Agent 记录格式无效。', 500);
  }

  await createHistoricalBackups(archivePath, saved);
  return migrated;
}

/**
 * 历史阶段性升级备份（保持幂等防覆盖）
 */
async function createHistoricalBackups(
  archivePath: string,
  saved: CharacterRecord[],
): Promise<void> {
  const content = await readFile(archivePath);
  const safeWrite = async (suffix: string) => {
    await writeFile(`${archivePath}${suffix}`, content, {
      mode: 0o600,
      flag: 'wx',
    }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
  };

  await safeWrite('.before-task-plan-module-v1.bak');
  await safeWrite('.before-agent-gateway-v1.bak');
  await safeWrite('.before-pi.bak');

  if (
    saved.some(
      (view) =>
        (view.runtime?.version ?? 0) < 3 ||
        view.taskBook?.runs.some(
          (run) => run.runtime && (run.runtime.version ?? 0) < 3,
        ),
    )
  ) {
    await safeWrite('.before-conversation-tasks-v2.bak');
  }

  if (saved.some((view) => !view.taskBook)) {
    await safeWrite('.before-task-plans.bak');
  }
}
