import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env';

let defaultClient: PrismaClient | undefined;

/** Creates an owned client; the caller must disconnect it after all consumers stop. */
export function createDatabaseClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/** 获取或初始化全局共享的数据库客户端单例 */
export function getDatabaseClient(connectionString?: string): PrismaClient {
  if (defaultClient) return defaultClient;
  const url = connectionString ?? env.databaseUrl();
  if (!url) {
    throw new Error('必须配置 DATABASE_URL 才能连接数据库。');
  }
  defaultClient = createDatabaseClient(url);
  return defaultClient;
}

/** 注入自定义的客户端（例如测试或显式重置） */
export function setDatabaseClient(client: PrismaClient | undefined): void {
  defaultClient = client;
}

/** 重置当前单例指针（如果匹配或未指定） */
export function resetDatabaseClient(client?: PrismaClient): void {
  if (!client || defaultClient === client) {
    defaultClient = undefined;
  }
}

/** 断开并清空当前全局单例 */
export async function disconnectDatabase(): Promise<void> {
  if (defaultClient) {
    const client = defaultClient;
    defaultClient = undefined;
    await client.$disconnect();
  }
}

/** 全局数据库单例代理，调用属性时自动解析 client */
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = getDatabaseClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

/** Map an absent JSON document to SQL NULL rather than JSON null. */
export function databaseJson(value: Prisma.InputJsonValue | null) {
  return value ?? Prisma.DbNull;
}
