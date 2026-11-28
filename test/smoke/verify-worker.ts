#!/usr/bin/env bun
/**
 * GEN-0 (#652) gate, JOBS-3 shape: the standalone `worker.ts` runs on the CURRENT `codegen.config.yaml`, not on the
 * values it had when `subsystem install jobs` emitted the (emit-once) file.
 *
 * Under JOBS-3 the worker carries no jobs config at all: it boots the app's own `AppModule` (whose generated
 * `SUBSYSTEM_MODULES` compose `JobsEngineModule.forRoot` from `<generated>/app-config.ts`) and starts
 * `JOBS_EXECUTOR`. So the gate is two facts:
 *   1. `worker.ts` loads (its bootstrap is `import.meta.main`-gated, so nothing starts), starts `JOBS_EXECUTOR`, and
 *      names none of ADR-022's `JobWorkerModule` options;
 *   2. the regenerated `app-config.ts` carries the config set after install: each pool as a limiter of its
 *      concurrency, and the executor's poll interval.
 *
 * Usage: verify-worker.ts <tmpDir> <worker.ts> <app-config.ts> <{ pollMs, pools } json>  (paths project-relative)
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function fail(msg: string): never {
	console.error(`[worker-verify] FAIL: ${msg}`);
	process.exit(1);
}

async function main(): Promise<void> {
	const [tmpDir, workerRel, appConfigRel, expectedArg] = process.argv.slice(2);
	if (!tmpDir || !workerRel || !appConfigRel || !expectedArg) {
		fail('usage: verify-worker.ts <tmpDir> <worker.ts> <app-config.ts> <{ pollMs, pools } json>');
	}
	const expected = JSON.parse(expectedArg) as { pollMs: number; pools: Record<string, { concurrency: number }> };

	process.chdir(tmpDir);
	process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://stub:stub@127.0.0.1:1/stub';

	const workerSrc = fs.readFileSync(path.join(tmpDir, workerRel), 'utf-8');
	if (!/\.get(?:<.*>)?\(JOBS_EXECUTOR\)\.start\(\)/.test(workerSrc)) fail(`${workerRel} does not start JOBS_EXECUTOR`);
	for (const gone of ['JobWorkerModule', 'jobWorkerOptions', 'allPools']) {
		if (workerSrc.includes(gone)) fail(`${workerRel} still names ADR-022's ${gone}`);
	}
	await import(pathToFileURL(path.join(tmpDir, workerRel)).href);

	const { jobLimiters, jobsInProcessOptions } = (await import(
		pathToFileURL(path.join(tmpDir, appConfigRel)).href
	)) as { jobLimiters?: Record<string, { inFlight: number }>; jobsInProcessOptions?: { pollMs?: number } };
	if (!jobLimiters || !jobsInProcessOptions) fail(`${appConfigRel} does not export jobLimiters / jobsInProcessOptions`);
	for (const [name, pool] of Object.entries(expected.pools)) {
		const got = jobLimiters[name];
		if (got?.inFlight !== pool.concurrency) {
			fail(`limiter '${name}': expected inFlight ${pool.concurrency}, got ${JSON.stringify(got)}`);
		}
	}
	if (jobsInProcessOptions.pollMs !== expected.pollMs) {
		fail(`jobsInProcessOptions.pollMs: expected ${expected.pollMs}, got ${JSON.stringify(jobsInProcessOptions.pollMs)}`);
	}
	console.log(
		`[worker-verify] OK — worker.ts starts JOBS_EXECUTOR on the regenerated config (limiters ${Object.keys(expected.pools).join(', ')}, pollMs ${expected.pollMs})`,
	);
}

main().catch((err) => {
	console.error('[worker-verify] FAIL: worker.ts did not load:');
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
	process.exit(1);
});
