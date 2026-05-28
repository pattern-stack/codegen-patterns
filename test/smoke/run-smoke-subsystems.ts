#!/usr/bin/env bun
/**
 * Subsystems smoke — locks in the #6 swe-brain-unblock criterion.
 *
 * Sibling to `run-smoke.ts` (which installs the COMBINER subsystems —
 * observability + auth + auth-integrations — and therefore never exercises
 * the alternate-backend prune path). This one installs the two real
 * implementation subsystems (events + jobs) with their default `drizzle`
 * backend, generates a fixture entity, and runs the consumer tree through
 * `bunx tsc --noEmit` with NO subsystem excludes.
 *
 * Acceptance:
 *   1. tsc reports zero errors against the consumer tree.
 *   2. No `src/shared/subsystems` exclude appears in the generated
 *      `tsconfig.json` (consumers who workaround-excluded those after
 *      0.9.x must be able to drop the exclude).
 *   3. No static `from 'bullmq'` / `from 'ioredis'` line survives in the
 *      vendored subsystem tree (the lazy-load + filter contract from #6).
 *
 * A regression here means a future PR re-introduced the static-import
 * leak that forced swe-brain to exclude `src/shared/subsystems` in 0.9.x.
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
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegen-smoke-subsystems-'));
	log(`tmp dir: ${tmpDir}`);

	let exitCode = 0;

	try {
		// 1. bun init + install pinned deps.
		run('bun init -y', tmpDir);
		run(`bun add ${RUNTIME_DEPS.join(' ')}`, tmpDir);
		run(`bun add -D ${DEV_DEPS.join(' ')}`, tmpDir);

		// 2. codegen project init.
		run(`bun ${CLI_PATH} project init --yes --with-tsconfig`, tmpDir);

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

		// 5. Install events + jobs (drizzle defaults — the real consumer path).
		//    NO --backend flag: this exercises the default the lead's swe-brain
		//    dogfood actually hits.
		run(`bun ${CLI_PATH} subsystem install events`, tmpDir);
		run(`bun ${CLI_PATH} subsystem install jobs`, tmpDir);

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
	} catch (err: unknown) {
		logError(err instanceof Error ? err.message : String(err));
		exitCode = 1;
	} finally {
		cleanup(tmpDir);
	}

	log(exitCode === 0 ? 'subsystems smoke PASS' : 'subsystems smoke FAIL');
	return exitCode;
}

main().then((code) => process.exit(code));
