import { defineConfig } from 'tsup';

/**
 * Local build config for @pattern-stack/codegen-crm. Without this, tsup walks
 * up and picks the repo-root tsup.config.ts (whose `tsconfig:
 * tsconfig.build.json` lacks this package's `paths` mapping for the L1 import),
 * so the DTS step can't resolve `@pattern-stack/codegen/subsystems`. Pinning the
 * package tsconfig here makes the cross-package type import resolve during the
 * declaration build.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/testing/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  dts: true,
  clean: true,
  sourcemap: true,
  tsconfig: 'tsconfig.json',
});
