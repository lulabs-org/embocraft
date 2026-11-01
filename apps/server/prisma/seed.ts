import { createDatabaseClient } from '../src/core/database/client';
import {
  DEFAULT_CHARACTER,
  DEFAULT_PROVIDERS,
  DEFAULT_TTS_PROVIDER,
} from './seed-data';
import type { Prisma } from '@prisma/client';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for seeding.');
const prisma = createDatabaseClient(connectionString);

async function main() {
  for (const provider of DEFAULT_PROVIDERS) {
    await prisma.agentProvider.upsert({
      where: { id: provider.id },
      create: provider,
      update: {},
    });
  }

  await prisma.ttsProvider.upsert({
    where: { id: DEFAULT_TTS_PROVIDER.id },
    create: DEFAULT_TTS_PROVIDER,
    update: {},
  });

  await prisma.agentCharacter.upsert({
    where: { id: DEFAULT_CHARACTER.id },
    create: {
      ...DEFAULT_CHARACTER,
      permissions: DEFAULT_CHARACTER.permissions,
      skills: DEFAULT_CHARACTER.skills as unknown as Prisma.InputJsonValue,
      state: {
        connectOrCreate: {
          where: { characterId: DEFAULT_CHARACTER.id },
          create: { status: 'stopped' },
        },
      },
    },
    update: {
      state: {
        connectOrCreate: {
          where: { characterId: DEFAULT_CHARACTER.id },
          create: { status: 'stopped' },
        },
      },
    },
  });
}

main()
  .catch((e) => {
    console.error('基础配置 Seed 失败：', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
