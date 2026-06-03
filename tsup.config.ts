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
 *
 * `splitting: true` (0.15.2): esbuild ESM code-splitting hoists any module
 * imported by >1 entry into a single SHARED chunk that those entries import,
 * instead of INLINING a fresh copy into every entry. This is required for
 * correctness, not just size: stateful module-singletons — chiefly
 * `runtime/subsystems/jobs/job-handler.base`'s `JOB_HANDLER_REGISTRY` Map and
 * its `HandlerRegistry` namespace, mutated at import time by the `@JobHandler`
 * decorator — were being duplicated across the `jobs/*` and `bridge/*` entry
 * chunks. The framework's own `@JobHandler('@framework/bridge_delivery')`
 * registered into the bridge chunk's copy while the jobs `JobWorker` read the
 * jobs chunk's copy, so the worker never upserted the handler's `job` row and
 * package-mode bridge *deliveries* deadlocked on the `wrapper_run_id` FK.
 * Splitting collapses these to one shared chunk → one Map. The named per-entry
 * output files are preserved (each entry stays a physical `dist/runtime/.../x.js`),
 * so the `./runtime/*` wildcard `exports` map + the deep consumer subpaths
 * (`.../subsystems/jobs/index`, `.../bridge/index`, `./subsystems`) still
 * resolve 1:1. Safe because the build is ESM-only (esbuild splitting is an
 * ESM-only feature; there is no CJS output to regress).
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
  splitting: true,
  sourcemap: true,
  outExtension: () => ({ js: ".js" }),
});
