import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@pattern-stack/graph-components': path.resolve(
        __dirname,
        '../../packages/graph-components/src',
      ),
    },
  },
  server: {
    port: 5180,
    open: true,
  },
  build: {
    outDir: 'dist',
  },
});
