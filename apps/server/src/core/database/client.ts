import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env';

export const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.databaseUrl() }),
});

/** Map an absent JSON document to SQL NULL rather than JSON null. */
export function databaseJson(value: Prisma.InputJsonValue | null) {
  return value ?? Prisma.DbNull;
}
