#!/usr/bin/env bun
/**
 * GEN-0 (#652) gate: the standalone `worker.ts` boots with the options the
 * CURRENT `codegen.config.yaml` declares — not the ones it had when
 * `subsystem install jobs` emitted the (emit-once) file.
 *
 * Imports `<backend_src>/worker.ts` (its bootstrap is `import.meta.main`-gated,
 * so nothing spawns), reads `WorkerAppModule`'s imports, and takes the value of
 * the `JobWorkerModule` dynamic module's `JOB_WORKER_MODULE_OPTIONS` provider —
 * exactly what `JobWorkerOrchestrator` would be injected with. The worker is
 * not booted: its pool workers would query the (stub) database at init.
 *
 * Usage: verify-worker.ts <tmpDir> <worker.ts, project-relative> <expected-json>
 * where <expected-json> is `{ drizzle: {…camelCase}, pools: {…} }`.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** `JOB_WORKER_MODULE_OPTIONS` — `Symbol.for(tokenKey('jobs', 'worker-module-options'))` (ADR-037). */
const JOB_WORKER_MODULE_OPTIONS = Symbol.for('@pattern-stack/codegen.jobs.worker-module-options');

function fail(msg: string): never {
	console.error(`[worker-verify] FAIL: ${msg}`);
	process.exit(1);
}

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

async function main(): Promise<void> {
	const [tmpDir, workerRel, expectedArg] = process.argv.slice(2);
	if (!tmpDir || !workerRel || !expectedArg) {
		fail('usage: verify-worker.ts <tmpDir> <worker.ts> <{ drizzle, pools } json>');
	}
	const expected = JSON.parse(expectedArg) as { drizzle: Record<string, unknown>; pools: Record<string, unknown> };

	// The worker's path aliases resolve against the tmp project's tsconfig.
	process.chdir(tmpDir);
	process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://stub:stub@127.0.0.1:1/stub';

	const { WorkerAppModule } = (await import(pathToFileURL(path.join(tmpDir, workerRel)).href)) as {
		WorkerAppModule?: object;
	};
	if (!WorkerAppModule) fail(`${workerRel} does not export WorkerAppModule`);

	const imports = (Reflect as unknown as { getMetadata(k: string, t: object): unknown }).getMetadata(
		'imports',
		WorkerAppModule,
	) as Array<{ module?: { name?: string }; providers?: Array<{ provide?: unknown; useValue?: unknown }> }>;
	const worker = imports.find((m) => m?.module?.name === 'JobWorkerModule');
	if (!worker) fail('WorkerAppModule does not import JobWorkerModule.forRoot(...)');
	const opts = worker.providers?.find((p) => p.provide === JOB_WORKER_MODULE_OPTIONS)?.useValue as
		| Record<string, unknown>
		| undefined;
	if (!opts) fail('JobWorkerModule.forRoot provided no JOB_WORKER_MODULE_OPTIONS value');

	if (opts.mode !== 'standalone') fail(`mode: expected 'standalone', got ${JSON.stringify(opts.mode)}`);
	// JOBS-0 (#656): the configured backend is stated, never left to forRoot's default.
	if (opts.backend !== 'drizzle') fail(`backend: expected 'drizzle', got ${JSON.stringify(opts.backend)}`);
	if (opts.allPools !== true) fail(`allPools: expected true, got ${JSON.stringify(opts.allPools)}`);
	const drizzle = (opts.domainModuleExtensions as { drizzle?: unknown } | undefined)?.drizzle;
	if (!same(drizzle, expected.drizzle)) {
		fail(`domainModuleExtensions.drizzle: expected ${JSON.stringify(expected.drizzle)}, got ${JSON.stringify(drizzle)}`);
	}
	if (!same(opts.domainModulePools, expected.pools)) {
		fail(`domainModulePools: expected ${JSON.stringify(expected.pools)}, got ${JSON.stringify(opts.domainModulePools)}`);
	}
	console.log(
		`[worker-verify] OK — worker.ts boots with the regenerated options (drizzle ${JSON.stringify(drizzle)}, pools ${Object.keys(expected.pools).join(', ')})`,
	);
}

main().catch((err) => {
	console.error('[worker-verify] FAIL: worker.ts did not load:');
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
	process.exit(1);
});
