import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

/**
 * Studio dev server.
 *
 * Two ways the UI reaches the API, and they are not the same path:
 *
 * - `just studio` — the browser loads the page from the **Studio server**,
 *   which proxies non-`/api` requests here. Requests are same-origin and the
 *   proxy below is never used.
 * - `bun run dev` on its own — the browser loads the page from Vite, and the
 *   proxy below forwards `/api` to the server. The `Origin` header stays
 *   `127.0.0.1:5179`, which the server allows only when it was told about the
 *   Vite origin (`--vite`, which the recipe passes). A state-changing request
 *   from anywhere else is a 403 — that is the CSRF control working, not a bug.
 *
 * `STUDIO_SERVER_PORT` retargets this proxy. It is needed whenever the server
 * is not on `STUDIO_DEFAULT_PORT` (5178) — `just studio <dir> <port>` takes a
 * port but cannot reach in here to set it, so pass the env var alongside.
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
    // Explicitly IPv4. Vite's default host resolves `localhost`, which binds
    // ::1 only on this platform, and the Studio server proxies the UI at
    // 127.0.0.1 — so the default bind makes `just studio` serve 502s.
    host: '127.0.0.1',
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
