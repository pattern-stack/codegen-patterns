import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

/**
 * Studio dev server.
 *
 * `/api` is proxied to the Studio server (`codegen studio`, default port 5178 —
 * `STUDIO_DEFAULT_PORT` in the shared contract) so the UI fetches same-origin
 * and nothing needs CORS. `STUDIO_SERVER_PORT` overrides the target when the
 * server was started on another port.
 */
const serverPort = Number(process.env.STUDIO_SERVER_PORT ?? 5178);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@pattern-stack/graph-components': path.resolve(
        __dirname,
        '../../packages/graph-components/src',
      ),
      // The Studio API contract. Types only — nothing from `src/` reaches the
      // browser bundle, because every import of it is `import type`.
      '@studio-shared': path.resolve(__dirname, '../../src/studio/shared/api.ts'),
    },
  },
  server: {
    port: 5179,
    strictPort: true,
    open: false,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${serverPort}`,
        changeOrigin: false,
        // The run log is Server-Sent Events; buffering it would defeat the
        // point of streaming it into the drawer.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
