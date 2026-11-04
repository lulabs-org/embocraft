import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Colyseus initializes PM2 telemetry, which writes to process.send in a fork.
    // Threads keep that IPC channel separate without mocking the server lifecycle.
    pool: 'threads',
    fileParallelism: false,
    testTimeout: 10000,
  },
});
