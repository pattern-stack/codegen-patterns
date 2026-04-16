import { defineConfig } from "tsup";

/**
 * Two build entries that cover the whole published shape:
 *
 *   src/index.ts           → dist/index.js        (library entry)
 *   src/cli/index.ts       → dist/cli.js         (bin — preserved shebang)
 *   runtime/ **\/*.ts      → dist/runtime/**\/*.js (consumer-imported base
 *                             classes + subsystems, exposed via exports map)
 *
 * ESM-only output targeting Node 20+. Bun runs ESM natively. CJS consumers
 * are out of scope — @pattern-stack/codegen is a 2026-era tool.
 */
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/cli/index.ts",
    "runtime/**/*.ts",
  ],
  outDir: "dist",
  format: ["esm"],
  target: "node20",
  clean: true,
  dts: {
    compilerOptions: {
      baseUrl: undefined,
      paths: undefined,
    },
  },
  tsconfig: "tsconfig.build.json",
  splitting: false,
  sourcemap: true,
  outExtension: () => ({ js: ".js" }),
});
