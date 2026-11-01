import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'prisma/config';

const dir = dirname(fileURLToPath(import.meta.url));
const rootEnv = resolve(dir, '../../.env');
if (existsSync(rootEnv)) {
  loadDotenv({ path: rootEnv });
} else {
  loadDotenv();
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL || 'postgresql://placeholder:5432/db',
  },
});
