#!/usr/bin/env bun
/**
 * Subsystems smoke — locks in the #6 swe-brain-unblock criterion + the
 * events/jobs/bridge dependency-graph wiring.
 *
 * Sibling to `run-smoke.ts` (which installs the COMBINER subsystems —
 * observability + auth + auth-integrations — and therefore never exercises
 * the alternate-backend prune path). This one installs the three real
 * implementation subsystems that share a dependency graph (events → jobs →
 * bridge — bridge consumes both) with their default `drizzle` backend,
 * generates a fixture entity, and validates the full consumer tree against
 * both type-level (`tsc`) and runtime-level (Nest boot) contracts.
 *
 * Acceptance:
 *   1. `tsc --noEmit` reports zero errors against the consumer tree.
 *   2. No `src/shared/subsystems` exclude appears in the generated
 *      `tsconfig.json` (consumers who workaround-excluded those after
 *      0.9.x must be able to drop the exclude).
 *   3. No static `from 'bullmq'` / `from 'ioredis'` line survives in the
 *      vendored subsystem tree (the lazy-load + filter contract from #6).
 *   4. Programmatic `NestFactory.create(AppModule)` + `app.init()` either
 *      resolves cleanly OR throws `BridgeReservedPoolsNotPolledError`.
 *      Any other failure mode is a regression in the bridge ↔ jobs ↔
 *      events dependency graph. See `verify-subsystems-boot.ts`.
 *
 * A regression here means a future PR re-introduced the static-import
 * leak that forced swe-brain to exclude `src/shared/subsystems` in 0.9.x,
 * OR broke the events/jobs/bridge wiring at the module-graph level.
 */

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');
const FIXTURES_DIR = path.join(REPO_ROOT, 'test', 'smoke', 'fixtures');

const KEEP = process.env.KEEP_SMOKE_DIR === '1';

// Same pinned set as the main smoke — must stay in sync if the main smoke's
// list moves.
const RUNTIME_DEPS = [
	'@nestjs/common@10',
	'@nestjs/core@10',
	'@nestjs/platform-express@10',
	'@nestjs/swagger@7',
	'@anatine/zod-openapi@2',
	'drizzle-orm@0.45',
	'reflect-metadata@0.2',
	'pg@8',
	'zod@3',
	'yaml@2',
];
const DEV_DEPS = ['typescript@5', '@types/bun', '@types/pg@8'];

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const t0 = Date.now();
const elapsed = (): string => `[+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`;
const log = (msg: string): void => console.log(`${elapsed()} ${msg}`);
const logError = (msg: string): void => console.error(`${elapsed()} [FAIL] ${msg}`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string, cwd: string): void {
	log(`$ ${cmd}`);
	execSync(cmd, { cwd, stdio: 'inherit', env: process.env });
}

function runSilent(cmd: string, cwd: string): { code: number; out: string; err: string } {
	const parts = cmd.split(' ');
	const r = spawnSync(parts[0], parts.slice(1), { cwd, encoding: 'utf-8' });
	return { code: r.status ?? 0, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/**
 * Mirror of `filterConsumerErrors` in run-smoke.ts (kept narrow + duplicated
 * intentionally — extracting to a shared module would add cross-script
 * coupling for two tiny consumers). Filters out the documented pre-existing
 * runtime-tree noise (drizzle 0.30↔0.45 mismatch, mixin-erasure on
 * declarative queries) so any NEW tsc error in the consumer tree fails the
 * smoke loudly.
 */
function filterConsumerErrors(output: string): string[] {
	const lines = output.split('\n').filter((l) => l.trim());
	const errors: string[] = [];
	for (const line of lines) {
		if (line.includes('../') || line.includes('/codegen-patterns/runtime/')) continue;
		if (line.includes('node_modules/')) continue;
		if (line.includes('TS5101')) continue;
		if (!/error TS\d+:/.test(line)) continue;
		if (/\.schema\.ts\(\d+,\d+\): error/.test(line)) continue;
		if (line.includes("Property 'table' in type") && line.includes('not assignable')) continue;
		if (line.includes('Cannot assign an abstract constructor')) continue;
		if (/Argument of type .* is not assignable to parameter of type 'Constructor<\{\}>'/.test(line)) {
			continue;
		}
		if (
			/Property '(findBy[A-Z]\w*|findById|findAll|list|findWithDeleted|findOnlyDeleted)'/.test(line)
		) {
			continue;
		}
		errors.push(line);
	}
	return errors;
}

function cleanup(dir: string): void {
	if (KEEP) {
		log(`keeping tmp dir (KEEP_SMOKE_DIR=1): ${dir}`);
		return;
	}
	try {
		fs.rmSync(dir, { recursive: true, force: true });
		log(`cleaned up ${dir}`);
	} catch (err: unknown) {
		logError(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Walk every `.ts` file under a directory; return any line that contains a
 * top-level static `from '<pkg>'` import for one of the listed packages.
 * Dynamic `await import('<pkg>')` expressions are NOT matched — they're the
 * lazy-load mechanism #6 explicitly relies on (the consumer's tsc treats
 * non-literal specifiers as `any`).
 */
function findStaticPeerImports(dir: string, pkgs: string[]): string[] {
	const offenders: string[] = [];
	const re = new RegExp(`^\\s*import[^;]*\\sfrom\\s+['"](${pkgs.join('|')})['"]`, 'm');
	const walk = (d: string): void => {
		if (!fs.existsSync(d)) return;
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			const full = path.join(d, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.name.endsWith('.ts')) continue;
			const src = fs.readFileSync(full, 'utf-8');
			if (re.test(src)) offenders.push(full);
		}
	};
	walk(dir);
	return offenders;
}

// ---------------------------------------------------------------------------
// Vendored leg — installs the real implementation subsystems against `@shared/*`
// ---------------------------------------------------------------------------

async function vendoredLeg(): Promise<number> {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegen-smoke-subsystems-'));
	log(`[vendored] tmp dir: ${tmpDir}`);

	let exitCode = 0;

	try {
		// 1. bun init + install pinned deps.
		run('bun init -y', tmpDir);
		run(`bun add ${RUNTIME_DEPS.join(' ')}`, tmpDir);
		run(`bun add -D ${DEV_DEPS.join(' ')}`, tmpDir);

		// 2. codegen project init. `--runtime vendored` (ADR-037) — this smoke
		//    vendors + compiles the runtime subsystems against `@shared/*`, so it
		//    is the vendored flow; the new `package` default would skip vendoring.
		run(`bun ${CLI_PATH} project init --yes --with-tsconfig --runtime vendored`, tmpDir);

		// 3. Copy the minimal fixture set (account + contact) — same shape
		//    the main smoke uses for its non-relationship scenario.
		const entitiesDir = path.join(tmpDir, 'entities');
		fs.mkdirSync(entitiesDir, { recursive: true });
		const examplePath = path.join(entitiesDir, 'example.yaml');
		if (fs.existsSync(examplePath)) fs.rmSync(examplePath);
		for (const f of fs.readdirSync(FIXTURES_DIR).filter((x) => x.endsWith('.yaml'))) {
			fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(entitiesDir, f));
		}

		// 4. Generate the entity layer.
		run(`bun ${CLI_PATH} entity new --all --force`, tmpDir);

		// 5. Install events + jobs + bridge (drizzle defaults — the real
		//    consumer path). NO --backend flag: this exercises the default
		//    the swe-brain dogfood actually hits. Bridge is the
		//    dependency-graph linchpin — it consumes both events tokens
		//    (EVENT_BUS) and jobs tokens (JOB_ORCHESTRATOR), and any
		//    re-export gap analogous to the ones D first missed in
		//    events/jobs would surface here.
		run(`bun ${CLI_PATH} subsystem install events`, tmpDir);
		run(`bun ${CLI_PATH} subsystem install jobs`, tmpDir);
		run(`bun ${CLI_PATH} subsystem install bridge`, tmpDir);
		// #473 — observability is a combiner (ADR-025) that composes the read
		// ports above via @Optional() DI. Installing it here exercises the
		// composer the issue added (it must emit ObservabilityModule.forRoot
		// AFTER the four infra subsystems in SUBSYSTEM_MODULES).
		run(`bun ${CLI_PATH} subsystem install observability`, tmpDir);

		// 5a-prep. The jobs install scaffold defaults `worker_mode: embedded`
		//   in codegen.config.yaml, which has the barrel emit
		//   `JobWorkerModule.forRoot({ mode: 'embedded' })` in `SUBSYSTEM_MODULES`.
		//   `JobWorkerOrchestrator.onModuleInit` performs Postgres I/O
		//   (`upsertJobRows`) which we can't satisfy without a real DB.
		//   For the smoke boot check, flip to `worker_mode: standalone` so
		//   the barrel skips JobWorkerModule and the boot exercises the
		//   Events + JobsDomain + Bridge graph without a DB write. The
		//   `subsystem install events --force --force-config` rerun below
		//   regenerates the barrel against the patched config.
		{
			const configPath = path.join(tmpDir, 'codegen.config.yaml');
			const cfg = fs.readFileSync(configPath, 'utf-8');
			// Replace the worker_mode line in the `jobs:` block. The block
			// emits a single `worker_mode: <value>` entry; a forgiving regex
			// rewrites both `embedded` and an explicitly-written `standalone`
			// (idempotent).
			const patched = cfg.replace(
				/^(\s*worker_mode:\s*)\w+/m,
				'$1standalone',
			);
			if (patched === cfg) {
				log('warning: jobs.worker_mode key not found in codegen.config.yaml; boot check may hit DB I/O');
			} else {
				fs.writeFileSync(configPath, patched, 'utf-8');
			}
		}

		// 5a. Second pass of `entity new --all` AFTER bridge install — the
		//     bridge-registry generator only emits
		//     `<subsystemsRoot>/bridge/generated/registry.ts` when the bridge
		//     dir exists, and bridge.module.ts statically imports from it. The
		//     events-side `generated/bus.ts` is regenerated the same way.
		//     One additional pass is cheap and matches the
		//     two-pass pattern already used by the relationship scenario.
		run(`bun ${CLI_PATH} entity new --all --force`, tmpDir);

		// 5a-post. Re-install events with --force (NO --force-config — we
		//   want to KEEP the patched `worker_mode: standalone`). The
		//   subsystem install flow regenerates `src/generated/subsystems.ts`
		//   from the current codegen.config.yaml, so after this the barrel
		//   no longer includes `JobWorkerModule.forRoot(...)`. Cheap re-run.
		run(`bun ${CLI_PATH} subsystem install events --force`, tmpDir);

		// 5b. Sanity check: the install scaffold should have appended the
		//     `bridge:` config block, and bridge.module.ts must be present
		//     in the vendored tree. Both conditions are what makes the
		//     barrel composer emit `BridgeModule.forRoot(...)`.
		const configYamlAfter = fs.readFileSync(
			path.join(tmpDir, 'codegen.config.yaml'),
			'utf-8',
		);
		if (!configYamlAfter.includes('bridge:')) {
			throw new Error('bridge: block missing from codegen.config.yaml after install');
		}
		const bridgeModulePath = path.join(
			tmpDir,
			'src/shared/subsystems/bridge/bridge.module.ts',
		);
		if (!fs.existsSync(bridgeModulePath)) {
			throw new Error(`bridge.module.ts missing after install: ${bridgeModulePath}`);
		}
		const barrelPath = path.join(tmpDir, 'src/generated/subsystems.ts');
		const barrel = fs.readFileSync(barrelPath, 'utf-8');

		// 0.20.x (#472/#473) — EVERY installed subsystem with a composer must emit
		// its `forRoot` into SUBSYSTEM_MODULES. This class of gap (install adds a
		// config entry but the barrel never wires the module) has now bitten twice
		// — events' scheduler (#471/#472) and observability (#473) — and survived
		// because nothing end-to-end asserted forRoot presence per subsystem.
		// Assert the module-name → forRoot mapping for everything this smoke
		// installs (the four infra subsystems + the observability combiner).
		const expectedForRoots: Record<string, string> = {
			events: 'EventsModule.forRoot',
			jobs: 'JobsDomainModule.forRoot',
			bridge: 'BridgeModule.forRoot',
			observability: 'ObservabilityModule.forRoot',
		};
		for (const [name, frag] of Object.entries(expectedForRoots)) {
			if (!barrel.includes(frag)) {
				throw new Error(
					`generated barrel does not include ${frag}(...) after ` +
						`installing '${name}' (install added the config entry but the ` +
						`barrel never wired the module):\n${barrel}`,
				);
			}
		}

		// #473 — observability is a combiner: its forRoot MUST register AFTER the
		// read ports it composes (it consumes their tokens via @Optional() DI).
		// Assert it comes after jobs/bridge in the emitted SUBSYSTEM_MODULES.
		const obsIdx = barrel.indexOf('ObservabilityModule.forRoot');
		for (const before of ['JobsDomainModule.forRoot', 'BridgeModule.forRoot']) {
			if (obsIdx < barrel.indexOf(before)) {
				throw new Error(
					`ObservabilityModule.forRoot must register AFTER ${before} ` +
						`(combiner composes its read port via @Optional() DI):\n${barrel}`,
				);
			}
		}

		// ADR-039 / 0.20.1 — the barrel MUST thread the consumer's generated
		// `eventRegistry` into `EventsModule.forRoot`, or `EventSchedulerLifecycle`
		// never spawns and scheduled events silently don't tick (the 0.20.0 gap
		// that survived because nothing end-to-end checked the threading). Assert
		// both the import and the forRoot option, on the real generated barrel.
		if (!/import \{ eventRegistry \} from '[^']+'/.test(barrel)) {
			throw new Error(
				`generated barrel does not import eventRegistry (ADR-039 scheduler threading):\n${barrel}`,
			);
		}
		if (!/EventsModule\.forRoot\(\{[^}]*eventRegistry[^}]*\}\)/.test(barrel)) {
			throw new Error(
				`generated barrel's EventsModule.forRoot does not thread eventRegistry ` +
					`(ADR-039 scheduler would never spawn):\n${barrel}`,
			);
		}

		// 5c. Wire SUBSYSTEM_MODULES into AppModule. The CLI's install flow
		//     intentionally LEAVES the wiring as a manual step (prints a
		//     TODO + relies on the user to spread `...SUBSYSTEM_MODULES`
		//     into AppModule.imports). For the smoke's boot check to
		//     exercise the bridge ↔ jobs ↔ events dependency graph for
		//     real, we apply that wiring here.
		//
		//     Patch shape (idempotent):
		//       - Add `import { SUBSYSTEM_MODULES } from './generated/subsystems';`
		//       - Inject `...SUBSYSTEM_MODULES,` into the AppModule `imports`
		//         array, immediately after `OpenApiModule,` to honor the
		//         registration-order constraint from the `subsystems` skill
		//         (Database first → OpenApi → SubsystemModules → Generated).
		const appModulePath = path.join(tmpDir, 'src/app.module.ts');
		let appModuleSrc = fs.readFileSync(appModulePath, 'utf-8');
		if (!appModuleSrc.includes('SUBSYSTEM_MODULES')) {
			appModuleSrc =
				`import { SUBSYSTEM_MODULES } from './generated/subsystems';\n` +
				appModuleSrc;
			// The AppModule's imports line in the init-emitted template reads:
			//   imports: [DatabaseModule, OpenApiModule, ...GENERATED_MODULES],
			// Spread SUBSYSTEM_MODULES between OpenApiModule and GENERATED_MODULES.
			appModuleSrc = appModuleSrc.replace(
				/(imports:\s*\[DatabaseModule,\s*OpenApiModule,)\s*\.\.\.GENERATED_MODULES/,
				'$1 ...SUBSYSTEM_MODULES, ...GENERATED_MODULES',
			);
			fs.writeFileSync(appModulePath, appModuleSrc, 'utf-8');
		}
		// Sanity: the patch landed.
		if (!fs.readFileSync(appModulePath, 'utf-8').includes('...SUBSYSTEM_MODULES')) {
			throw new Error(
				'failed to wire SUBSYSTEM_MODULES into app.module.ts — the imports-array regex did not match. Init template may have drifted.',
			);
		}

		// 6. Acceptance #2 — assert no subsystem excludes leaked into the
		//    generated tsconfig.json. Consumers who hand-excluded
		//    `src/shared/subsystems` as a 0.9.x workaround must be able to drop
		//    that exclude; if `project init` or `subsystem install` started
		//    emitting an exclude, this catches it.
		const tsconfigPath = path.join(tmpDir, 'tsconfig.json');
		const tsconfigRaw = fs.readFileSync(tsconfigPath, 'utf-8');
		if (tsconfigRaw.includes('subsystems')) {
			throw new Error(
				`tsconfig.json mentions 'subsystems' — likely a leaked exclude:\n${tsconfigRaw}`,
			);
		}

		// 7. Acceptance #3 — assert no static `from 'bullmq'` / `from 'ioredis'`
		//    line survives in the vendored subsystem tree. The non-literal
		//    `await import(spec)` pattern in events.module / job-worker.module
		//    is fine (it doesn't match the regex). Locks in the contract from
		//    #6 — a future PR that re-introduces a static import is caught
		//    here, not after smoke users hit TS2307.
		const subsystemsRoot = path.join(tmpDir, 'src/shared/subsystems');
		const staticOffenders = findStaticPeerImports(subsystemsRoot, ['bullmq', 'ioredis']);
		if (staticOffenders.length > 0) {
			throw new Error(
				`found static 'bullmq'/'ioredis' imports in vendored subsystem tree (would force the consumer's tsc to resolve unbundled peer deps):\n  ${staticOffenders.join('\n  ')}`,
			);
		}

		// 8. Acceptance #1 — bunx tsc --noEmit over the WHOLE consumer tree.
		//    This is the swe-brain-unblock criterion: drizzle install + entity
		//    generation + full-tree typecheck, zero errors, no excludes.
		log('running bunx tsc --noEmit --skipLibCheck (full consumer tree, no subsystem excludes)');
		const tsc = runSilent('bunx tsc --noEmit --skipLibCheck', tmpDir);
		const errs = filterConsumerErrors(tsc.out + tsc.err);
		if (errs.length > 0) {
			for (const line of errs) console.error(line);
			logError(`${errs.length} typecheck error(s) in consumer-emitted code`);
			exitCode = 1;
		} else {
			log('tsc OK — consumer tree typechecks with no subsystem excludes');
		}

		// 9. Acceptance #4 — programmatic Nest boot. Mirror the openapi
		//    verifier's `NestFactory.create + app.init` pattern (see
		//    test/smoke/verify-openapi.ts). The bridge module's `onModuleInit`
		//    is the meaningful invariant: it injects `JOB_WORKER_MODULE_OPTIONS`
		//    `@Optional()` and throws `BridgeReservedPoolsNotPolledError` when
		//    JobWorkerModule is bound but isn't draining the reserved
		//    `events_*` pools. The verifier accepts either clean boot or that
		//    specific throw; any OTHER error indicates a regression in the
		//    events ↔ jobs ↔ bridge dependency graph.
		if (exitCode === 0) {
			log('verifying programmatic AppModule boot (bridge guard locks in events ↔ jobs ↔ bridge wiring)');
			const verifyResult = runSilent(
				`bun ${path.join(REPO_ROOT, 'test', 'smoke', 'verify-subsystems-boot.ts')} ${tmpDir}`,
				tmpDir,
			);
			if (verifyResult.code !== 0) {
				if (verifyResult.out.trim()) console.error(verifyResult.out);
				if (verifyResult.err.trim()) console.error(verifyResult.err);
				logError('subsystems boot verification failed');
				exitCode = 1;
			} else {
				if (verifyResult.out.trim()) {
					for (const line of verifyResult.out.split('\n')) {
						if (line.trim()) log(`  ${line}`);
					}
				}
				log('boot OK — events/jobs/bridge dependency graph wired correctly');
			}
		}
	} catch (err: unknown) {
		logError(err instanceof Error ? err.message : String(err));
		exitCode = 1;
	} finally {
		cleanup(tmpDir);
	}

	log(exitCode === 0 ? '[vendored] subsystems smoke PASS' : '[vendored] subsystems smoke FAIL');
	return exitCode;
}

// ---------------------------------------------------------------------------
// Package leg (#517) — package mode is the ADR-037 DEFAULT. Installing jobs
// must now emit the consumer-owned scaffold (`src/worker.ts` + the `src/main.ts`
// embedded-mode hook); the schema template is skipped (the schema ships in the
// package, re-exported via the schema barrel). #516 made the worker's
// JobWorkerModule import mode-aware; this leg locks in that the package-mode
// INSTALL path actually emits it.
//
// Acceptance:
//   1. `src/worker.ts` exists after a package-mode jobs install.
//   2. The worker imports `@pattern-stack/codegen/runtime/subsystems/jobs/index`
//      and carries NO `@shared/subsystems` reference (the vendored specifier).
//   3. NO templated schema vendored into the consumer's subsystems tree.
//   4. The consumer tree typechecks (`tsc --noEmit`). In checkout mode the
//      package isn't `bun add`-ed, so the worker's `@pattern-stack/codegen/`
//      import is unresolvable — that single line is filtered (same precedent as
//      run-smoke.ts), but every OTHER line in the worker (relative `./app.module`
//      import, the `forRoot` literal, the bootstrap body) must typecheck clean.
// ---------------------------------------------------------------------------

/**
 * Typecheck the emitted `src/worker.ts` in ISOLATION against a minimal local
 * `app.module.ts` stub.
 *
 * Why isolate: in package mode the consumer's ENTIRE generated tree (repos,
 * services, app.module) imports from `@pattern-stack/codegen/runtime/...`, which
 * is unresolvable in checkout mode (the package isn't `bun add`-ed) — so the
 * full-tree tsc the vendored leg runs is impossible here, and its errors are all
 * downstream of the unresolvable base-class imports, NOT worker bugs. #517 is
 * about whether the worker is EMITTED and structurally correct, so we typecheck
 * the worker alone. The worker's only package import (`JobWorkerModule`) is
 * filtered (run-smoke.ts precedent); its relative `./app.module` import resolves
 * against the stub, and every other line (the `forRoot` literal, the bootstrap
 * body, the `WorkerAppModule` class) must typecheck clean — that's the surface
 * #516 built and #517 wires.
 */
function typecheckWorkerInIsolation(tmpDir: string): string[] {
	const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegen-worker-tc-'));
	try {
		const workerSrc = fs.readFileSync(path.join(tmpDir, 'src', 'worker.ts'), 'utf-8');
		const srcDir = path.join(checkDir, 'src');
		fs.mkdirSync(srcDir, { recursive: true });
		fs.writeFileSync(path.join(srcDir, 'worker.ts'), workerSrc, 'utf-8');
		// Minimal AppModule stub so the worker's relative `./app.module` import
		// resolves without dragging the unresolvable generated tree.
		fs.writeFileSync(
			path.join(srcDir, 'app.module.ts'),
			"import { Module } from '@nestjs/common';\n@Module({})\nexport class AppModule {}\n",
			'utf-8',
		);
		// Reuse the consumer's deps (NestJS, reflect-metadata) by pointing
		// node_modules resolution at the tmpDir install.
		fs.writeFileSync(
			path.join(checkDir, 'tsconfig.json'),
			JSON.stringify(
				{
					compilerOptions: {
						target: 'ESNext',
						module: 'Preserve',
						moduleResolution: 'bundler',
						strict: true,
						skipLibCheck: true,
						noEmit: true,
						experimentalDecorators: true,
						emitDecoratorMetadata: true,
						allowImportingTsExtensions: true,
						types: [],
						baseUrl: '.',
						paths: { '*': [path.join(tmpDir, 'node_modules', '*')] },
					},
					include: ['src/**/*'],
				},
				null,
				2,
			),
			'utf-8',
		);
		const tsc = runSilent('bunx tsc --noEmit --skipLibCheck', checkDir);
		// Tolerate ONLY the unresolvable `@pattern-stack/codegen/` JobWorkerModule
		// import (the package isn't installed in checkout mode) — same precedent as
		// run-smoke.ts. Any OTHER error in the worker is a real bug.
		return filterConsumerErrors(tsc.out + tsc.err).filter(
			(line) => !line.includes("'@pattern-stack/codegen/"),
		);
	} finally {
		try {
			fs.rmSync(checkDir, { recursive: true, force: true });
		} catch {}
	}
}

async function packageLeg(): Promise<number> {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegen-smoke-subsystems-pkg-'));
	log(`[package] tmp dir: ${tmpDir}`);

	let exitCode = 0;

	try {
		// 1. bun init + install pinned deps (same set as the vendored leg).
		run('bun init -y', tmpDir);
		run(`bun add ${RUNTIME_DEPS.join(' ')}`, tmpDir);
		run(`bun add -D ${DEV_DEPS.join(' ')}`, tmpDir);

		// 2. project init in PACKAGE mode (the ADR-037 default — pass it
		//    explicitly for clarity). Package mode vendors no runtime tree;
		//    subsystems resolve from the published package. main.ts lands here so
		//    the embedded-mode hook has an injection target.
		run(`bun ${CLI_PATH} project init --yes --with-tsconfig --runtime package`, tmpDir);

		// 3. Install jobs in package mode — THE #517 path. Emits src/worker.ts +
		//    the src/main.ts embedded-mode hook; skips the schema template. NO
		//    entity generation: the package-mode generated tree can't typecheck in
		//    checkout mode (base classes live in the uninstalled package), and the
		//    worker — what #517 wires — is independent of it.
		run(`bun ${CLI_PATH} subsystem install jobs`, tmpDir);

		// 4. Acceptance #1 — worker.ts emitted (consumer-owned, NOT vendored).
		const workerPath = path.join(tmpDir, 'src', 'worker.ts');
		if (!fs.existsSync(workerPath)) {
			throw new Error(
				`package-mode jobs install did not emit src/worker.ts — executePackageMode short-circuited the scaffold (the #517 regression):\n${workerPath}`,
			);
		}
		const worker = fs.readFileSync(workerPath, 'utf-8');

		// Acceptance #2 — mode-aware import resolves to the PACKAGE, never @shared.
		if (!worker.includes("from '@pattern-stack/codegen/runtime/subsystems/jobs/index'")) {
			throw new Error(
				`src/worker.ts does not import JobWorkerModule from the package runtime subpath ` +
					`(#516 mode-aware import regression):\n${worker}`,
			);
		}
		if (worker.includes('@shared/subsystems')) {
			throw new Error(
				`src/worker.ts references '@shared/subsystems' in package mode — the vendored ` +
					`specifier leaked into the package-mode worker:\n${worker}`,
			);
		}

		// NOTE on the main.ts hook: the package-leg deliberately does NOT assert
		// the embedded-mode hook landed in the init-emitted main.ts. That
		// injection is pre-existingly broken (independent of #517 — same in
		// vendored mode): Hygen's `inject: after: "NestFactory.create"` silently
		// no-ops when the target file contains a `{ … : true }` boolean object
		// literal AFTER the anchor — and `project init`'s main.ts carries
		// `swaggerOptions: { persistAuthorization: true }`. The hook's injection
		// against a clean main.ts is covered by the subsystem.test.ts unit case;
		// see docs/specs/JOB-6.md Open Questions for the anchor-robustness item.

		// Acceptance #3 — NO templated schema vendored under the subsystems tree
		// (the schema ships in the package, re-exported via the schema barrel).
		const vendoredSchema = path.join(
			tmpDir,
			'src/shared/subsystems/jobs/job-orchestration.schema.ts',
		);
		if (fs.existsSync(vendoredSchema)) {
			throw new Error(
				`package mode vendored a templated job-orchestration.schema.ts — the schema ` +
					`should ship in the package (skipSchema skip_if regression):\n${vendoredSchema}`,
			);
		}

		// Acceptance #4 — the emitted worker typechecks (in isolation against an
		// AppModule stub; the package's JobWorkerModule import is the only line
		// filtered — checkout mode can't resolve it).
		log('[package] typechecking emitted src/worker.ts in isolation');
		const errs = typecheckWorkerInIsolation(tmpDir);
		if (errs.length > 0) {
			for (const line of errs) console.error(line);
			logError(`[package] ${errs.length} typecheck error(s) in emitted src/worker.ts`);
			exitCode = 1;
		} else {
			log('[package] tsc OK — emitted src/worker.ts typechecks');
		}
	} catch (err: unknown) {
		logError(err instanceof Error ? err.message : String(err));
		exitCode = 1;
	} finally {
		cleanup(tmpDir);
	}

	log(exitCode === 0 ? '[package] subsystems smoke PASS' : '[package] subsystems smoke FAIL');
	return exitCode;
}

// ---------------------------------------------------------------------------
// Main — run both legs; fail if either fails.
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
	const vendored = await vendoredLeg();
	const pkg = await packageLeg();
	const exitCode = vendored === 0 && pkg === 0 ? 0 : 1;
	log(exitCode === 0 ? 'subsystems smoke PASS (vendored + package)' : 'subsystems smoke FAIL');
	return exitCode;
}

main().then((code) => process.exit(code));
