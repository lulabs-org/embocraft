import { PrismaClient } from '@prisma/client';
import { DEFAULT_PROVIDERS, DEFAULT_TTS_PROVIDER } from './seed-data';

const prisma = new PrismaClient();

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
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
