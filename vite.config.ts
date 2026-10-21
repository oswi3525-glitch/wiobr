import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, '');
  const proxyHost = env.HOST && env.HOST !== '0.0.0.0' ? env.HOST : 'localhost';
  const apiTarget = `http://${proxyHost}:${env.PORT || 3000}`;
  return {
    root: 'client',
    plugins: [react()],
    build: {
      outDir: resolve(rootDir, 'dist'),
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      proxy: {
        '/api': apiTarget,
        '/ws': { target: apiTarget.replace('http://', 'ws://'), ws: true },
      },
    },
  };
});
