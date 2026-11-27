#!/usr/bin/env bun
/**
 * DI-resolution gate: boot the generated `AppModule` and assert the whole
 * NestJS dependency graph resolves.
 *
 * Runs inside a smoke harness tmp project (passed as argv[2]). It does the
 * one thing `tsc --noEmit` cannot: `NestFactory.create(AppModule)` +
 * `app.init()` instantiates every provider across every module, so a
 * cross-module wiring bug — a service injecting a sibling repo whose home
 * module doesn't export it, a junction module that can't resolve its parent
 * repos, an EAV value-table module missing the definition repo — throws here
 * instead of shipping to a consumer's first boot.
 *
 * This guard exists because that class of bug (a junction/EAV module that
 * typechecks but fails DI at runtime) shipped once: the junction + EAV
 * pipelines were only gated by `tsc` + grep, never by an actual boot. See
 * CHANGELOG 0.7.8.
 *
 * No OpenAPI assertions here (that's verify-openapi.ts) — this is purely
 * "does the container come up". DATABASE_URL is stubbed; pg.Pool is lazy and
 * no query fires during module init, so no real DB is needed.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function fail(msg: string): never {
	console.error(`[boot-verify] FAIL: ${msg}`);
	process.exit(1);
}

async function main(): Promise<void> {
	const [tmpDir, appModuleArg, ...flags] = process.argv.slice(2);
	if (!tmpDir) fail('usage: verify-boot.ts <tmpDir> [<app.module.ts, project-relative>] [--expect-pools <json>]');
	// `<paths.backend_src>/app.module.ts` — `src/` unless the harness says (PATH-0).
	const appModuleRel = appModuleArg ?? 'src/app.module.ts';
	// CFG-1: `--expect-pools <json>` — `jobs.pools` the config declared; after
	// boot, the app's `JOBS_LIMITER_CONFIG` must carry each as a limiter (JOBS-3).
	const poolsFlag = flags.indexOf('--expect-pools');
	const expectPools =
		poolsFlag >= 0
			? (JSON.parse(flags[poolsFlag + 1] ?? fail('--expect-pools needs a JSON value')) as Record<
					string,
					{ concurrency: number }
				>)
			: null;

	// AppModule's path aliases (@shared/*, @modules/*, @generated/*) resolve
	// relative to the tmp project's tsconfig — make it the cwd.
	process.chdir(tmpDir);

	const nestCoreUrl = pathToFileURL(
		path.join(tmpDir, 'node_modules', '@nestjs', 'core', 'index.js'),
	).href;
	const nestCommonUrl = pathToFileURL(
		path.join(tmpDir, 'node_modules', '@nestjs', 'common', 'index.js'),
	).href;
	const { NestFactory } = (await import(nestCoreUrl)) as typeof import('@nestjs/core');
	// Prime @nestjs/common from the tmp project to avoid package duplication.
	await import(nestCommonUrl);

	// pg.Pool never connects until a query runs; module init fires no queries.
	process.env.DATABASE_URL =
		process.env.DATABASE_URL ?? 'postgresql://stub:stub@127.0.0.1:1/stub';

	const appModuleUrl = pathToFileURL(
		path.join(tmpDir, appModuleRel),
	).href;
	const { AppModule } = (await import(appModuleUrl)) as { AppModule: unknown };

	// NestFactory.create + init resolves the ENTIRE provider graph. A missing
	// cross-module export surfaces as an UnknownDependenciesException here.
	const app = await NestFactory.create(AppModule as never, {
		logger: false,
		abortOnError: false,
	});
	await app.init();

	if (expectPools) {
		// `@pattern-stack/jobs/nest`'s `JOBS_LIMITER_CONFIG` (a `Symbol.for`): the limiters the executor runs. It is
		// fed ONLY by the generated `jobLimiters` (no boot-time YAML read), so a match proves generation → app.
		const limiters = app.get(Symbol.for('@pattern-stack/jobs.JOBS_LIMITER_CONFIG'), {
			strict: false,
		}) as Record<string, { inFlight?: number }> | undefined;
		if (!limiters) fail('JOBS_LIMITER_CONFIG is not bound — the jobs subsystem did not boot');
		for (const [name, want] of Object.entries(expectPools)) {
			const got = limiters[name];
			if (!got) fail(`limiter '${name}' missing from JOBS_LIMITER_CONFIG: [${Object.keys(limiters).join(', ')}]`);
			if (got.inFlight !== want.concurrency) fail(`limiter '${name}'.inFlight: expected ${want.concurrency}, got ${got.inFlight}`);
		}
		console.log(`[boot-verify] OK — JOBS_LIMITER_CONFIG carries the configured pools (${Object.keys(expectPools).join(', ')})`);
	}
	await app.close();

	console.log('[boot-verify] OK — AppModule DI graph resolves');
}

main().catch((err) => {
	// NestFactory throws here on an unresolved dependency — that's the failure
	// this guard is designed to catch, so surface it loudly and fail.
	console.error('[boot-verify] FAIL: AppModule did not boot:');
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
