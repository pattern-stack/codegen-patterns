import { defineConfig } from 'tsup';

/** Local build config, so tsup doesn't pick up the repo root's (see packages/codegen-crm/tsup.config.ts). */
export default defineConfig({
  entry: ['src/index.ts', 'src/commands.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'es2022',
  dts: true,
  clean: true,
  sourcemap: true,
  tsconfig: 'tsconfig.json',
});
