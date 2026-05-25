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
	const tmpDir = process.argv[2];
	if (!tmpDir) fail('usage: verify-boot.ts <tmpDir>');

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
		path.join(tmpDir, 'src', 'app.module.ts'),
	).href;
	const { AppModule } = (await import(appModuleUrl)) as { AppModule: unknown };

	// NestFactory.create + init resolves the ENTIRE provider graph. A missing
	// cross-module export surfaces as an UnknownDependenciesException here.
	const app = await NestFactory.create(AppModule as never, {
		logger: false,
		abortOnError: false,
	});
	await app.init();
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
