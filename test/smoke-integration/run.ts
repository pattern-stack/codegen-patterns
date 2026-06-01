#!/usr/bin/env bun
/**
 * Integration-compile smoke — `tsc --noEmit` the emitted `src/integrations/**`
 * tree end-to-end.
 *
 * WHY THIS EXISTS
 * ---------------
 * The emission tests under `test/integration-emit/` only assert the *string
 * content* of generated files — they never compile them. And `test/smoke/`
 * scaffolds + generates + `tsc`s a project but NEVER includes an integration
 * surface (no providers). So nothing in CI ever ran `tsc` against the emitted
 * `src/integrations/**` tree. That gap let two real bugs ship-to-branch,
 * invisible to every existing test:
 *
 *   1. A TS2420 port-contract break (a generated adapter no longer satisfied
 *      its surface port interface).
 *   2. A 24-error barrel-export gap — the generated per-entity sink/assembly
 *      modules import `IIntegrationSink` / `ExecuteIntegrationUseCase` /
 *      `INTEGRATION_CHANGE_SOURCE` / `INTEGRATION_SINK` from
 *      `@pattern-stack/codegen/subsystems`, which the runtime barrel didn't
 *      forward (TS2305).
 *
 * Both were caught only by manually compiling generated output. This test
 * closes that gap permanently.
 *
 * WHAT IT DOES
 * ------------
 *   1. Create a fresh tmp project (`bun init` + pinned peer deps).
 *   2. Link the 4 surface packages + `codegen` from the repo's node_modules so
 *      the temp project resolves the same workspace `just install` provides.
 *   3. `codegen project init --yes --with-tsconfig`.
 *   4. Rewrite the temp tsconfig to compile the emitted tree against the
 *      IN-REPO runtime + surface SOURCES — that's the contract under test.
 *      The R-series / assembly types live in the branch's runtime barrel, not
 *      yet in the published `@pattern-stack/codegen`, so we validate the
 *      branch's emitter against the branch's runtime, not a stale dist.
 *   5. Copy the checked-in `integration-patterns` entities + providers and the
 *      author-owned provider client + OAuth stubs (consumer-owned, not codegen).
 *   6. `codegen entity new --all --force` TWICE (two-pass: seed cross-entity
 *      refs, then emit the full integration tree).
 *   7. `bunx tsc --noEmit` and FAIL if there are any `error TS` lines whose
 *      path is under `src/integrations/**`.
 *
 * SCOPE OF THE FAILURE CHECK
 * --------------------------
 * Only errors under `src/integrations/**` fail the test. Two pre-existing,
 * out-of-scope errors live in `src/shared/subsystems/events/generated/bus.ts`
 * (the events subsystem isn't installed in this flow) — they are NOT
 * integration errors and must not false-fail this smoke.
 *
 * Set KEEP_SMOKE_DIR=1 to preserve the tmp project for inspection.
 */

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');
const FIXTURE_ROOT = path.join(
	REPO_ROOT,
	'test/fixtures/integration-patterns/definitions',
);
const STUBS_ROOT = path.join(REPO_ROOT, 'test/smoke-integration/stubs');
const RUNTIME_BARREL = path.join(REPO_ROOT, 'runtime/subsystems/index.ts');
const RUNTIME_SUBSYSTEMS = path.join(REPO_ROOT, 'runtime/subsystems');
const RUNTIME_ROOT = path.join(REPO_ROOT, 'runtime');

const KEEP = process.env.KEEP_SMOKE_DIR === '1';

// Surface packages linked by `just install` (node_modules/@pattern-stack/*).
const SURFACE_PACKAGES = ['crm', 'mail', 'calendar', 'transcript'] as const;
// Providers whose author-owned client + OAuth stubs ship under stubs/.
const PROVIDER_STUBS = ['google', 'salesforce'] as const;

// Pinned peer deps — version drift would undermine the harness. Mirrors
// test/smoke/run-smoke.ts; drizzle pinned to 0.45 to match the repo devDeps.
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
const DEV_DEPS = ['typescript@5', '@types/bun', '@types/node', '@types/pg@8'];

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const t0 = Date.now();
function elapsed(): string {
	const s = ((Date.now() - t0) / 1000).toFixed(1);
	return `[+${s.padStart(5)}s]`;
}
function log(msg: string): void {
	console.log(`${elapsed()} ${msg}`);
}
function logError(msg: string): void {
	console.error(`${elapsed()} [FAIL] ${msg}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string, cwd: string): void {
	log(`$ ${cmd}`);
	execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env } });
}

function runSilent(cmd: string, cwd: string): { code: number; out: string } {
	const parts = cmd.split(' ');
	const r = spawnSync(parts[0], parts.slice(1), { cwd, encoding: 'utf-8' });
	return { code: r.status ?? 0, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

function copyDir(src: string, dst: string): void {
	fs.mkdirSync(dst, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const s = path.join(src, entry.name);
		const d = path.join(dst, entry.name);
		if (entry.isDirectory()) copyDir(s, d);
		else fs.copyFileSync(s, d);
	}
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
 * Resolve the source entry for a workspace package linked under the repo's
 * node_modules. `just install` symlinks node_modules/@pattern-stack/* to the
 * workspace; we point tsc at the package's `src/index.ts` so the emitted tree
 * compiles against the in-repo surface SOURCES (CI-deterministic — no ad-hoc
 * symlinks, no dependence on a built dist/).
 */
function surfaceSrcEntry(surface: string): string {
	const entry = path.join(
		REPO_ROOT,
		`node_modules/@pattern-stack/codegen-${surface}/src/index.ts`,
	);
	if (!fs.existsSync(entry)) {
		throw new Error(
			`surface package source missing: ${entry}\n` +
				`Run \`just install\` to link node_modules/@pattern-stack/codegen-${surface}.`,
		);
	}
	return entry;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
	// Preflight: the 4 surface workspace packages must be linked. `just install`
	// (bun workspaces) guarantees these on a clean CI runner. We do NOT require
	// node_modules/@pattern-stack/codegen — that's a dev-machine global link and
	// the emitted tree never resolves through it: `@pattern-stack/codegen/...`
	// specifiers are aliased to the in-repo runtime via tsconfig paths below.
	const psRoot = path.join(REPO_ROOT, 'node_modules/@pattern-stack');
	for (const pkg of SURFACE_PACKAGES.map((s) => `codegen-${s}`)) {
		if (!fs.existsSync(path.join(psRoot, pkg))) {
			logError(
				`node_modules/@pattern-stack/${pkg} not linked — run \`just install\` first.`,
			);
			return 1;
		}
	}

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegen-integ-tsc-'));
	log(`tmp dir: ${tmpDir}`);

	let exitCode = 0;

	try {
		// 1. Fresh project + pinned deps.
		run('bun init -y', tmpDir);
		run(`bun add ${RUNTIME_DEPS.join(' ')}`, tmpDir);
		run(`bun add -D ${DEV_DEPS.join(' ')}`, tmpDir);

		// 2. Link the 4 surface workspace packages + codegen into the temp project
		//    so bare `@pattern-stack/*` specifiers resolve at the node level. tsc
		//    reads the SOURCES via tsconfig paths (below) — these links are belt-
		//    and-braces for any node-side resolution.
		//
		//    `codegen` links to the REPO ROOT (which IS the @pattern-stack/codegen
		//    package — see root package.json `name`), not to the dev-machine global
		//    link, so this reproduces on a clean CI runner.
		const tmpPs = path.join(tmpDir, 'node_modules/@pattern-stack');
		fs.mkdirSync(tmpPs, { recursive: true });
		fs.symlinkSync(REPO_ROOT, path.join(tmpPs, 'codegen'));
		for (const surface of SURFACE_PACKAGES) {
			const pkg = `codegen-${surface}`;
			// realpathSync resolves the repo's workspace symlink to its concrete
			// dir so the temp link is absolute + stable.
			fs.symlinkSync(
				fs.realpathSync(path.join(psRoot, pkg)),
				path.join(tmpPs, pkg),
			);
		}

		// 3. project init (writes codegen.config.yaml + a tsconfig with aliases).
		run(`bun ${CLI_PATH} project init --yes --with-tsconfig`, tmpDir);

		// 4. Rewrite tsconfig: compile the emitted tree against the IN-REPO runtime
		//    + surface SOURCES (the contract under test).
		const tsconfigPath = path.join(tmpDir, 'tsconfig.json');
		const tsconfig = JSON.parse(
			fs.readFileSync(tsconfigPath, 'utf-8').replace(/\/\/.*$/gm, ''),
		);
		tsconfig.compilerOptions ??= {};
		tsconfig.compilerOptions.paths ??= {};
		const paths = tsconfig.compilerOptions.paths;
		paths['@app/*'] = ['./src/*'];
		// The R-series + assembly types live in the LOCAL runtime barrel on this
		// branch, not yet in the published @pattern-stack/codegen. Validate the
		// branch's emitter against the branch's runtime.
		paths['@pattern-stack/codegen/subsystems'] = [RUNTIME_BARREL];
		paths['@pattern-stack/codegen/subsystems/*'] = [`${RUNTIME_SUBSYSTEMS}/*`];
		// ADR-037: `project init` now defaults to `runtime: package`, so the
		// emitted ENTITY tree imports runtime base-classes/types/constants from
		// `@pattern-stack/codegen/runtime/*` (not the vendored `@shared/*`). Alias
		// it to the in-repo runtime SOURCES so the whole generated tree — entities
		// included — compiles in package mode, the contract under test.
		paths['@pattern-stack/codegen/runtime/*'] = [`${RUNTIME_ROOT}/*`];
		// Surface packages are installed source-only (no built dist/).
		for (const surface of SURFACE_PACKAGES) {
			paths[`@pattern-stack/codegen-${surface}`] = [surfaceSrcEntry(surface)];
		}
		fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));

		// 5. config: ensure paths.providers points at the copied providers dir.
		const cfgPath = path.join(tmpDir, 'codegen.config.yaml');
		let cfg = fs.readFileSync(cfgPath, 'utf-8');
		if (!/^paths:/m.test(cfg)) cfg = `paths:\n${cfg}`;
		if (!/providers:/.test(cfg)) {
			cfg = cfg.replace(/^paths:\n/m, 'paths:\n  providers: definitions/providers\n');
		}
		fs.writeFileSync(cfgPath, cfg);

		// 6. Copy entities (replacing init's example.yaml) + providers.
		const entitiesDir = path.join(tmpDir, 'entities');
		fs.mkdirSync(entitiesDir, { recursive: true });
		const examplePath = path.join(entitiesDir, 'example.yaml');
		if (fs.existsSync(examplePath)) fs.rmSync(examplePath);
		copyDir(path.join(FIXTURE_ROOT, 'entities'), entitiesDir);
		copyDir(
			path.join(FIXTURE_ROOT, 'providers'),
			path.join(tmpDir, 'definitions/providers'),
		);

		// 7. Author-owned provider client + OAuth stubs (consumer-owned, committed
		//    under stubs/ — not codegen's job to emit).
		for (const provider of PROVIDER_STUBS) {
			copyDir(
				path.join(STUBS_ROOT, provider),
				path.join(tmpDir, 'src/integrations/providers', provider),
			);
		}

		// 8. Generate twice (two-pass: seed cross-entity refs, then the full
		//    integration tree).
		run(`bun ${CLI_PATH} entity new --all --force`, tmpDir);
		run(`bun ${CLI_PATH} entity new --all --force`, tmpDir);

		// Sanity: the integration tree must actually have been emitted, else a
		// silent "no providers detected" regression would make this test pass
		// vacuously.
		const integRoot = path.join(tmpDir, 'src/integrations');
		const integFiles = fs.existsSync(integRoot)
			? execSync(`find src/integrations -type f -name '*.ts'`, { cwd: tmpDir })
					.toString()
					.split('\n')
					.filter(Boolean)
			: [];
		// Subtract the author-owned stubs (4 files) — require generated files too.
		const generatedCount = integFiles.filter(
			(f) => !/integrations\/providers\/(google|salesforce)\/(google|salesforce)(\.client|-oauth\.strategy)\.ts$/.test(f),
		).length;
		log(`src/integrations: ${integFiles.length} .ts files (${generatedCount} generated)`);
		if (generatedCount === 0) {
			throw new Error(
				'no generated files under src/integrations/** — emission did not run ' +
					'(providers not detected?). This test would pass vacuously.',
			);
		}

		// 9. tsc --noEmit, scoped to src/integrations/**.
		log('running bunx tsc --noEmit --skipLibCheck');
		const tsc = runSilent('bunx tsc --noEmit --skipLibCheck', tmpDir);

		const allErrorLines = tsc.out
			.split('\n')
			.filter((l) => /error TS\d+:/.test(l));
		const integErrors = allErrorLines.filter((l) =>
			/(^|[\s(])src[/\\]integrations[/\\]/.test(l),
		);
		const otherErrors = allErrorLines.filter(
			(l) => !/(^|[\s(])src[/\\]integrations[/\\]/.test(l),
		);

		// Out-of-scope errors (e.g. src/shared/subsystems/events/generated/bus.ts —
		// events subsystem not installed in this flow) are reported for visibility
		// but never fail the test.
		if (otherErrors.length > 0) {
			log(
				`${otherErrors.length} tsc error(s) OUTSIDE src/integrations/** (out of scope — not failing):`,
			);
			for (const l of otherErrors.slice(0, 20)) console.log(`  ${l}`);
		}

		if (integErrors.length > 0) {
			logError(
				`${integErrors.length} tsc error(s) in src/integrations/** (the integration tree did NOT compile):`,
			);
			for (const l of integErrors) console.error(l);
			exitCode = 1;
		} else {
			log('tsc OK — src/integrations/** compiles clean against in-repo runtime + surfaces');
		}
	} catch (err: unknown) {
		logError(err instanceof Error ? err.message : String(err));
		exitCode = 1;
	} finally {
		cleanup(tmpDir);
	}

	log(exitCode === 0 ? 'smoke-integration PASS' : 'smoke-integration FAIL');
	return exitCode;
}

main().then((code) => process.exit(code));
