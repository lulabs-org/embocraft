import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const rootDir = path.resolve(__dirname, '../..');
  const env = loadEnv(mode, rootDir, '');
  const port = Number(env.WEB_PORT) || 5173;
  const serverHost = env.SERVER_HOST || '127.0.0.1';
  const serverPort = env.SERVER_PORT || '2567';

  return {
    envDir: rootDir,
    plugins: [react()],
    define: {
      ...(mode === 'development' && !env.VITE_SERVER_URL
        ? {
            'import.meta.env.VITE_SERVER_URL': JSON.stringify(
              `ws://${serverHost}:${serverPort}`,
            ),
          }
        : {}),
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            three: ['three'],
            react: ['react', 'react-dom'],
            network: ['colyseus.js'],
          },
        },
      },
    },
    server: {
      port,
      strictPort: false,
    },
  };
});
