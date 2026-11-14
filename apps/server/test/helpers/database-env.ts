// Set the database address before importing the shared Prisma client.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl && !new URL(testDatabaseUrl).pathname.endsWith('_test')) {
  throw new Error('TEST_DATABASE_URL 必须指向专用的 _test 数据库。');
}
process.env.DATABASE_URL = testDatabaseUrl ?? '';
