import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@kram/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@kram/time': fileURLToPath(new URL('../../packages/engine-time/src/index.ts', import.meta.url))
    }
  },
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:8420' } },
  build: { outDir: '../../dist/web', emptyOutDir: true, sourcemap: true }
});
