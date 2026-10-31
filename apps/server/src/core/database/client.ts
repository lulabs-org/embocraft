import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/** Creates an owned client; the caller must disconnect it after all consumers stop. */
export function createDatabaseClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/** Map an absent JSON document to SQL NULL rather than JSON null. */
export function databaseJson(value: Prisma.InputJsonValue | null) {
  return value ?? Prisma.DbNull;
}
