#!/usr/bin/env bun
/**
 * Subsystems boot verifier — runs inside the run-smoke-subsystems.ts tmp
 * project (path passed as argv[2]).
 *
 * Boots the consumer's AppModule with `NestFactory.create` + `app.init()`,
 * which fires every module's `onModuleInit`. The interesting hook is
 * `BridgeModule.onModuleInit` — it inspects `JobWorkerModule`'s active
 * pools and throws `BridgeReservedPoolsNotPolledError` when any of the
 * reserved `events_*` pools aren't being drained. With a default install
 * (which only emits `JobWorkerModule.forRoot({ mode: 'embedded' })`, no
 * explicit `pools` + no `allPools`), the guard is expected to fire — and
 * THAT is the invariant this verifier locks in: the bridge module loads,
 * Nest's DI resolves it AND `JobWorkerModule` together, and the fail-fast
 * guard executes.
 *
 * Accepted outcomes:
 *   - `app.init()` resolves cleanly (pools were wired — e.g. a future PR
 *     adds `allPools: true` to the barrel default).
 *   - `app.init()` rejects with `BridgeReservedPoolsNotPolledError`.
 *
 * Any other outcome (DI resolution failure, unrelated boot error,
 * unexpected throw) fails the verifier and the smoke.
 *
 * Mirrors `verify-openapi.ts` for the import + bootstrap pattern (stub
 * DATABASE_URL, resolve nest from the tmp project's node_modules, chdir
 * so tsconfig path aliases resolve).
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

	// Also resolve the bridge module so we can identify its error class by
	// name (instanceof across realms is fragile; constructor.name is stable).
	// Path is canonical per the install layout: <subsystemsRoot>/bridge/.
	const bridgeErrorsUrl = pathToFileURL(
		path.join(tmpDir, 'src', 'shared', 'subsystems', 'bridge', 'bridge-errors.ts'),
	).href;
	let expectedErrorName = 'BridgeReservedPoolsNotPolledError';
	try {
		const errors = (await import(bridgeErrorsUrl)) as Record<string, unknown>;
		const ctor = errors['BridgeReservedPoolsNotPolledError'];
		if (typeof ctor === 'function') expectedErrorName = (ctor as { name: string }).name;
	} catch {
		// Fall back to the literal name if the module path drifts.
	}

	let app: { init: () => Promise<unknown>; close: () => Promise<void> } | null = null;
	let initError: unknown = null;
	try {
		app = (await NestFactory.create(AppModule as never, {
			logger: false,
			abortOnError: false,
		})) as { init: () => Promise<unknown>; close: () => Promise<void> };
		await app.init();
	} catch (err) {
		initError = err;
	}

	// Branch on the outcome.
	if (initError === null) {
		// Boot succeeded — pools must be wired, OR allPools was true. Either
		// way: dependency graph resolves, bridge.onModuleInit passed. Accept.
		console.log(
			'[subsystems-boot-verify] OK — AppModule boot succeeded (bridge guard passed; pools wired or allPools)',
		);
		if (app) {
			try {
				await app.close();
			} catch {
				// Ignore — close errors are not part of the invariant.
			}
		}
		process.exit(0);
	}

	// Boot failed — only acceptable failure is the bridge reserved-pools guard.
	const errAsObj = initError as { constructor?: { name?: string }; name?: string; message?: string };
	const ctorName = errAsObj?.constructor?.name ?? errAsObj?.name ?? '';
	const message = errAsObj?.message ?? String(initError);

	if (ctorName === expectedErrorName || message.includes('reserved') && message.includes('pool')) {
		console.log(
			`[subsystems-boot-verify] OK — AppModule booted up to bridge guard which fired the expected ${expectedErrorName} (reserved pools not polled in default install)`,
		);
		process.exit(0);
	}

	fail(
		`AppModule boot failed with an unexpected error: ${ctorName || '(no ctor)'}: ${message}\n` +
			`Acceptable outcomes: (a) clean boot, or (b) throw of ${expectedErrorName}. ` +
			`Any other error indicates a regression in the events/jobs/bridge dependency graph.`,
	);
}

main().catch((err: unknown) => {
	fail(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
});
