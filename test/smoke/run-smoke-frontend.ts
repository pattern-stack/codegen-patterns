#!/usr/bin/env bun
/**
 * Frontend smoke harness — does the emitted frontend tree COMPILE (FE-0, #620).
 *
 * The gap this closes: until now the emitted frontend tree was type-checked
 * nowhere. `test/frontend-golden` compares bytes and says so in its own header
 * — the baseline tsconfig cannot resolve `@repo/db/entities` or
 * `@pattern-stack/frontend-patterns`. So a dependency set that made the emitted
 * collections uncompilable shipped unnoticed: the four `@tanstack/*` packages
 * resolved four different `@tanstack/db` copies and
 * `createCollection(electricCollectionOptions(...))` failed with a `sync.sync`
 * type mismatch naming two of them. See `docs/specs/FE-0.md`.
 *
 *  1. Fresh tmp project, `bun init`.
 *  2. Write the version-pairing contract into package.json — dependencies AND
 *     the `overrides` entry — using `mergeFrontendDeps`, the SAME function the
 *     CLI uses, so the gate exercises the emitted contract rather than a
 *     hand-written copy of it. Then `bun install` it for real, from npm.
 *  3. Assert exactly ONE `@tanstack/db` is installed. A future range change
 *     that re-splits the tree then names itself instead of surfacing as an
 *     opaque TS2769 three steps later.
 *  4. `codegen project init` + `entity new --all` with `generate.frontend: true`.
 *  5. Supply the CONSUMER-OWNED modules the contract requires
 *     (`@repo/db/entities/*`, `@/lib/collections/auth`) from
 *     `test/smoke/fixtures-frontend/consumer/`, mapped by tsconfig paths.
 *     Nothing codegen emits is stubbed — no template writes to those locations.
 *  6. `bunx tsc --noEmit` over the emitted tree, scoped through
 *     `_consumer-errors.ts` BY LOCATION ONLY. No message filters, no directory
 *     carve-outs, no predicate added to that helper (charter I9, GATE-2).
 *  7. Clean up unless KEEP_SMOKE_DIR=1.
 *
 * Installs from live npm like every other smoke here (~12 s, ~110 packages on
 * a warm bun cache). Nothing is vendored or stubbed: a pinned local copy would
 * hide exactly the class of defect this exists to catch.
 */

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { consumerErrors as scopeToConsumer } from './_consumer-errors';
import { mergeFrontendDeps } from '../../src/cli/shared/init-scaffold';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');
const FIXTURES = path.join(REPO_ROOT, 'test', 'smoke', 'fixtures-frontend');
const KEEP = process.env.KEEP_SMOKE_DIR === '1';

/**
 * Deps the emitted frontend does NOT import but the toolchain needs: React (a
 * peer of the sync layer and of `@tanstack/react-db`), `zod` (the consumer's
 * `@repo/db` schemas are Zod, as they are in every pattern-stack app), and
 * TypeScript itself. The emitted-tree deps come from `FRONTEND_EMITTED_DEPS`
 * via `mergeFrontendDeps` — they are NOT duplicated here, so this harness can
 * never drift from the contract it is gating.
 */
const TOOLCHAIN_DEPS = ['react@^19', 'react-dom@^19', 'zod@^3'];
const TOOLCHAIN_DEV_DEPS = ['typescript@5', '@types/react@^19', '@types/react-dom@^19'];

const t0 = Date.now();
const elapsed = (): string => `[+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`;
const log = (msg: string): void => console.log(`${elapsed()} ${msg}`);
const logError = (msg: string): void => console.error(`${elapsed()} [FAIL] ${msg}`);

function run(cmd: string, cwd: string): void {
	log(`$ ${cmd}`);
	execSync(cmd, { cwd, stdio: 'inherit' });
}

function runSilent(cmd: string, cwd: string): { code: number; out: string; err: string } {
	const parts = cmd.split(' ');
	const r = spawnSync(parts[0]!, parts.slice(1), { cwd, encoding: 'utf-8' });
	return { code: r.status ?? 0, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** Every installed copy of a package, as `<relative dir> -> <version>`. */
function installedCopies(tmpDir: string, pkg: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		const nm = path.join(dir, 'node_modules');
		if (!fs.existsSync(nm)) return;
		const candidate = path.join(nm, pkg);
		if (fs.existsSync(path.join(candidate, 'package.json'))) {
			const version = JSON.parse(
				fs.readFileSync(path.join(candidate, 'package.json'), 'utf8'),
			).version as string;
			out.push(`${path.relative(tmpDir, candidate)} -> ${version}`);
		}
		for (const entry of fs.readdirSync(nm, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const child = path.join(nm, entry.name);
			// Scoped dirs (`@tanstack`) hold packages one level deeper.
			if (entry.name.startsWith('@')) {
				for (const scoped of fs.readdirSync(child, { withFileTypes: true })) {
					if (scoped.isDirectory()) walk(path.join(child, scoped.name));
				}
			} else {
				walk(child);
			}
		}
	};
	walk(tmpDir);
	return [...new Set(out)].sort();
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

async function main(): Promise<number> {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegen-smoke-frontend-'));
	log(`tmp dir: ${tmpDir}`);
	let exitCode = 0;

	try {
		// 1. Fresh project.
		run('bun init -y', tmpDir);

		// 2. The version-pairing contract, written by the CLI's own merge so this
		//    harness cannot drift from it, then installed for real.
		const pkgPath = path.join(tmpDir, 'package.json');
		const merged = mergeFrontendDeps(fs.readFileSync(pkgPath, 'utf8'));
		if (merged.parseError) throw new Error(`package.json unparseable: ${merged.parseError}`);
		if (merged.unchanged) throw new Error('mergeFrontendDeps added nothing to a fresh package.json');
		fs.writeFileSync(pkgPath, merged.content);
		log(`frontend contract merged: ${merged.added.join(', ')}`);
		run('bun install', tmpDir);
		run(`bun add ${TOOLCHAIN_DEPS.join(' ')}`, tmpDir);
		run(`bun add -D ${TOOLCHAIN_DEV_DEPS.join(' ')}`, tmpDir);

		// 3. One @tanstack/db, or the emitted collections cannot be typed.
		const dbCopies = installedCopies(tmpDir, path.join('@tanstack', 'db'));
		for (const copy of dbCopies) log(`  @tanstack/db: ${copy}`);
		if (dbCopies.length !== 1) {
			throw new Error(
				`expected exactly 1 installed @tanstack/db, found ${dbCopies.length}:\n  ` +
					`${dbCopies.join('\n  ')}\n` +
					'Every copy is a separate type identity, so the emitted collections stop ' +
					'compiling. See docs/specs/FE-0.md — the lockstep pins in ' +
					'src/emitters/frontend/deps.ts plus its FRONTEND_DEP_OVERRIDES are what ' +
					'keep this at one.',
			);
		}

		// 4. Scaffold + generate with the frontend pipeline on.
		run(`bun ${CLI_PATH} project init --yes --with-tsconfig --runtime package`, tmpDir);

		// `project init` writes `generate.frontend` from what the scanner detected,
		// which for a fresh directory is `false` and there is no `--frontend` flag.
		// Edit the block in place — appending a second `generate:` key produces a
		// YAML document whose second mapping silently loses to the first.
		const configPath = path.join(tmpDir, 'codegen.config.yaml');
		const config = parseYaml(fs.readFileSync(configPath, 'utf8')) as {
			generate?: Record<string, unknown>;
		};
		config.generate = { ...config.generate, architecture: 'clean-lite-ps', frontend: true };
		fs.writeFileSync(configPath, stringifyYaml(config, { indent: 2 }));

		const entitiesDir = path.join(tmpDir, 'entities');
		fs.mkdirSync(entitiesDir, { recursive: true });
		const examplePath = path.join(entitiesDir, 'example.yaml');
		if (fs.existsSync(examplePath)) fs.rmSync(examplePath);
		for (const f of fs.readdirSync(path.join(FIXTURES, 'entities'))) {
			fs.copyFileSync(path.join(FIXTURES, 'entities', f), path.join(entitiesDir, f));
			log(`copied fixture: ${f}`);
		}

		run(`bun ${CLI_PATH} entity new --all --force`, tmpDir);

		// The emitter is opt-in; if it silently did not run, this gate would pass
		// without compiling anything it is supposed to gate.
		const frontendDir = path.join(tmpDir, 'apps', 'frontend', 'src', 'generated');
		if (!fs.existsSync(path.join(frontendDir, 'index.ts'))) {
			throw new Error(
				`frontend emitter produced nothing at ${path.relative(tmpDir, frontendDir)} — ` +
					'`generate.frontend: true` did not take effect',
			);
		}
		for (const required of [
			'collections/account.ts', // electric branch — where FE-0's failure was
			'collections/contact.ts', // api branch
			'store/resolvers.ts', // belongs_to FK resolver
			'store/index.ts', // createStore wiring
		]) {
			if (!fs.existsSync(path.join(frontendDir, required))) {
				throw new Error(`frontend emitter did not write ${required}`);
			}
		}

		// 5. The consumer-owned modules the contract requires. Not stubs of
		//    generated code — no template writes to either location (ADR-038).
		const consumerDir = path.join(tmpDir, 'consumer');
		fs.mkdirSync(consumerDir, { recursive: true });
		for (const f of fs.readdirSync(path.join(FIXTURES, 'consumer'))) {
			fs.copyFileSync(path.join(FIXTURES, 'consumer', f), path.join(consumerDir, f));
		}

		fs.writeFileSync(
			path.join(tmpDir, 'tsconfig.frontend.json'),
			`${JSON.stringify(
				{
					compilerOptions: {
						target: 'ES2022',
						module: 'ESNext',
						moduleResolution: 'Bundler',
						jsx: 'react-jsx',
						strict: true,
						skipLibCheck: true,
						noEmit: true,
						// The posture a real consumer app compiles under, and the one
						// charter I9 says a repo-side `typecheck` does not reproduce.
						noUncheckedIndexedAccess: true,
						baseUrl: '.',
						paths: {
							'@repo/db/entities/*': ['./consumer/*'],
							'@/lib/collections/auth': ['./consumer/auth'],
						},
					},
					include: ['apps/frontend/src/generated/**/*', 'consumer/**/*'],
				},
				null,
				2,
			)}\n`,
		);

		// 6. Typecheck — scoped by LOCATION only (I9).
		log('running bunx tsc --noEmit -p tsconfig.frontend.json');
		const tsc = runSilent('bunx tsc --noEmit -p tsconfig.frontend.json', tmpDir);
		const errors = scopeToConsumer(tsc.out + tsc.err, tmpDir);
		if (errors.length > 0) {
			for (const line of errors) console.error(line);
			logError(`${errors.length} typecheck errors in the emitted frontend tree`);
			exitCode = 1;
		} else {
			log('tsc OK (the emitted frontend tree compiles against the real install)');
		}
	} catch (err: unknown) {
		logError(err instanceof Error ? err.message : String(err));
		exitCode = 1;
	} finally {
		cleanup(tmpDir);
	}

	log(exitCode === 0 ? 'smoke-frontend PASS' : 'smoke-frontend FAIL');
	return exitCode;
}

process.exit(await main());
