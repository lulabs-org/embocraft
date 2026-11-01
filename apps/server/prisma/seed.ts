import { createDatabaseClient } from '../src/core/database/client';
import { DEFAULT_PROVIDERS, DEFAULT_TTS_PROVIDER } from './seed-data';

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
}

main()
  .catch((e) => {
    console.error('基础配置 Seed 失败：', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
