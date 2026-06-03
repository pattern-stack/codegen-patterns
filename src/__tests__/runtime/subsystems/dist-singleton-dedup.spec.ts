/**
 * Dist-singleton dedup regression (0.15.2).
 *
 * The published bundle is ESM, multi-entry (`runtime/**\/*.ts` each become a
 * physical `dist/runtime/.../x.js` so the `./runtime/*` wildcard `exports` map
 * resolves 1:1). Before 0.15.2 the build ran with `splitting: false`, so esbuild
 * INLINED every shared module into each entry chunk that imported it. For pure
 * functions / types that is harmless, but for a STATEFUL module-singleton it is
 * a correctness bug: `runtime/subsystems/jobs/job-handler.base`'s
 * `JOB_HANDLER_REGISTRY` Map (mutated at import time by the `@JobHandler`
 * decorator) was duplicated across the `jobs/*` and `bridge/*` entry chunks. The
 * framework's own `@JobHandler('@framework/bridge_delivery')` (in the bridge
 * chunk) then registered into the BRIDGE copy while the jobs `JobWorker` read the
 * JOBS copy → the worker never upserted the wrapper's `job` row → package-mode
 * bridge deliveries deadlocked on the `job_run.job_type → job(type)` FK.
 *
 * `tsup.config.ts` now sets `splitting: true`, which hoists each such shared
 * module into a SINGLE shared chunk that every entry imports. This test guards
 * that invariant against the BUILT dist: there must be exactly one
 * `JOB_HANDLER_REGISTRY = new Map()` definition and one `HandlerRegistry`
 * read-facade implementation across all emitted `.js`.
 *
 * Skips when `dist/` is absent (e.g. a fresh checkout before `bun run build`) so
 * `bun test` stays green without a prior build; CI builds before testing.
 */
import { describe, it, expect } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(import.meta.dir, '../../../../dist');

/** All `.js` files under dist (excludes `.js.map`, which embed source text). */
function distJsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...distJsFiles(full));
    } else if (entry.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function countMatches(files: string[], pattern: RegExp): number {
  let n = 0;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const m = src.match(pattern);
    if (m) n += m.length;
  }
  return n;
}

const describeOrSkip = existsSync(DIST) ? describe : describe.skip;

describeOrSkip('dist singleton dedup (0.15.2 — splitting hoists shared state)', () => {
  const files = existsSync(DIST) ? distJsFiles(DIST) : [];

  it('emits exactly ONE JOB_HANDLER_REGISTRY Map across the whole bundle', () => {
    // The decorator's write target. >1 copy ⇒ register-vs-read split the Map.
    const count = countMatches(files, /JOB_HANDLER_REGISTRY = (?:\/\* @__PURE__ \*\/ )?new Map/g);
    expect(count).toBe(1);
  });

  it('emits exactly ONE HandlerRegistry read-facade implementation', () => {
    // `HandlerRegistry.getAll()` is backed by `Array.from(JOB_HANDLER_REGISTRY.values())`.
    // A duplicated impl ⇒ a second namespace over a second Map.
    const count = countMatches(
      files,
      /Array\.from\(JOB_HANDLER_REGISTRY\.values\(\)\)/g,
    );
    expect(count).toBe(1);
  });

  it('shares that singleton chunk between the jobs worker and the bridge handler', () => {
    // Both the @JobHandler-decorated BridgeDeliveryHandler (bridge entry) and the
    // JobWorker (jobs entry) must import the SAME chunk that defines the Map.
    const registryChunk = files.find((f) =>
      /JOB_HANDLER_REGISTRY = (?:\/\* @__PURE__ \*\/ )?new Map/.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(registryChunk).toBeDefined();
    const chunkBase = registryChunk!.split('/').pop()!;

    const bridgeHandler = readFileSync(
      join(DIST, 'runtime/subsystems/bridge/bridge-delivery-handler.js'),
      'utf8',
    );
    const jobWorker = readFileSync(
      join(DIST, 'runtime/subsystems/jobs/job-worker.js'),
      'utf8',
    );
    expect(bridgeHandler).toContain(chunkBase);
    expect(jobWorker).toContain(chunkBase);
  });
});
