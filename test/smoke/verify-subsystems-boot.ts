#!/usr/bin/env bun
/**
 * Subsystems boot verifier — runs inside the run-smoke-subsystems.ts tmp
 * project (path passed as argv[2]).
 *
 * Boots the consumer's AppModule with `NestFactory.create` + `app.init()`,
 * which fires every module's `onModuleInit`, and asserts the events ↔ jobs ↔
 * bridge graph resolved (JOBS-3): `JobsEngineModule`'s `JOBS_EXECUTOR` and
 * `JOBS_REGISTRY` are bound, the bridge's `EVENT_FLOW` resolved (it injects
 * `JobStarter`), and the registry holds the jobs the generated
 * `<generated>/jobs.ts` lists. ADR-022's reserved-pool guard is gone, so the
 * one accepted outcome is a clean boot; any error is a regression.
 *
 * Mirrors `verify-openapi.ts` for the import + bootstrap pattern (stub
 * DATABASE_URL, resolve nest from the tmp project's node_modules, chdir
 * so tsconfig path aliases resolve).
 *
 * Usage: verify-subsystems-boot.ts <tmpDir> [<job key>…]  — each key must be registered.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function fail(msg: string): never {
	console.error(`[subsystems-boot-verify] FAIL: ${msg}`);
	process.exit(1);
}

async function main(): Promise<void> {
	const tmpDir = process.argv[2];
	if (!tmpDir) fail('usage: verify-subsystems-boot.ts <tmpDir>');

	process.chdir(tmpDir);

	const nestCoreUrl = pathToFileURL(
		path.join(tmpDir, 'node_modules', '@nestjs', 'core', 'index.js'),
	).href;
	const nestCommonUrl = pathToFileURL(
		path.join(tmpDir, 'node_modules', '@nestjs', 'common', 'index.js'),
	).href;
	const { NestFactory } = (await import(nestCoreUrl)) as typeof import('@nestjs/core');
	await import(nestCommonUrl);

	// Stub DATABASE_URL — pg.Pool doesn't connect until a query fires; no
	// query fires during onModuleInit for the modules we care about
	// (events/jobs/bridge wiring is type-/token-resolution, not DB I/O).
	process.env.DATABASE_URL =
		process.env.DATABASE_URL ?? 'postgresql://stub:stub@127.0.0.1:1/stub';

	const appModuleUrl = pathToFileURL(
		path.join(tmpDir, 'src', 'app.module.ts'),
	).href;
	const { AppModule } = (await import(appModuleUrl)) as { AppModule: unknown };

	const expectedJobKeys = process.argv.slice(3);
	let app: { init: () => Promise<unknown>; close: () => Promise<void>; get: (t: unknown, o?: unknown) => unknown };
	try {
		app = (await NestFactory.create(AppModule as never, { logger: false, abortOnError: false })) as never;
		await app.init();
	} catch (err) {
		const e = err as { constructor?: { name?: string }; message?: string };
		fail(`AppModule boot failed: ${e?.constructor?.name ?? '(no ctor)'}: ${e?.message ?? String(err)}`);
	}
	try {
		const executor = app.get(Symbol.for('@pattern-stack/jobs.JOBS_EXECUTOR'), { strict: false });
		if (!executor) fail('JOBS_EXECUTOR is not bound — JobsEngineModule did not compose');
		const registry = app.get(Symbol.for('@pattern-stack/jobs.JOBS_REGISTRY'), { strict: false }) as
			| { has(key: string): boolean }
			| undefined;
		if (!registry) fail('JOBS_REGISTRY is not bound');
		for (const key of expectedJobKeys) {
			if (!registry.has(key)) fail(`job '${key}' is not registered — the generated jobs.ts did not reach JobsEngineModule`);
		}
		if (!app.get('EVENT_FLOW', { strict: false })) fail('EVENT_FLOW is not bound — BridgeModule did not compose');
	} finally {
		try {
			await app.close();
		} catch {
			// Close errors are not part of the invariant.
		}
	}
	console.log(
		`[subsystems-boot-verify] OK — AppModule booted; JOBS_EXECUTOR, JOBS_REGISTRY (${expectedJobKeys.join(', ') || 'no jobs'}) and EVENT_FLOW resolve`,
	);
	process.exit(0);
}

main().catch((err: unknown) => {
	fail(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
});
