#!/usr/bin/env bun
/**
 * Pattern-stack wiring smoke (PW-3): a project with `target: { wiring: pattern-stack, http: none }` compiles with NO `@nestjs/*`
 * package, no `reflect-metadata`, and decorators off.
 *
 * 1. A fresh tmp project: `bun init`, then the runtime deps WITHOUT Nest, and `@pattern-stack/wiring` from this
 *    checkout's `packages/wiring` (PW-2).
 * 2. `codegen project init --runtime vendored --wiring pattern-stack` (PW-4): the config's target, a `database`
 *    system, `compose.ts`, `main.ts` and an empty composition, and no Nest scaffold. The project compiles here, before
 *    any entity.
 * 3. `tsconfig.json`: init turned on neither `experimentalDecorators` nor `emitDecoratorMetadata`.
 * 4. The fixtures in `test/smoke/fixtures-pattern-stack/` (two contexts, a cross-context `belongs_to`, a mutual composition,
 *    a root entity) through `entity new --all`.
 * 5. Gates:
 *    - no file in the project imports `@nestjs/*` or `reflect-metadata`, and `node_modules` has neither;
 *    - the composition files exist (one `module.ts` per context, `<generated>/wiring.ts`, `<generated>/composition.ts`,
 *      `<generated>/openapi.ts`);
 *    - `tsc` over the project, scoped by location only (`_consumer-errors.ts`), like every smoke;
 *    - `bun src/main.ts` composes, starts and stops the app (the pool connects on first use, so no database).
 *
 * Booting the composition and running CRUD through the use cases on Postgres is the integration job's
 * (`test/scaffold/`, Docker), not this Docker-free gate.
 */

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tscGateErrors } from './_consumer-errors';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = `bun ${path.join(REPO_ROOT, 'src', 'cli', 'index.ts')}`;
const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures-pattern-stack');
/** PW-3c: the junctions, a sibling folder so the entity loaders never read them as entities. */
const JUNCTIONS_DIR = path.join(import.meta.dirname, 'fixtures-pattern-stack-junctions');
const USAGE_FILE = path.join(import.meta.dirname, 'fixtures-pattern-stack-usage', 'crud-check.ts');
// `--postgres <url>` (the integration job): after the compile gate, push the schema into a fresh database on that
// server and run CRUD through the composed use cases (`fixtures-pattern-stack-usage/crud-check.ts`).
const POSTGRES_URL = (() => {
	const i = process.argv.indexOf('--postgres');
	return i === -1 ? null : (process.argv[i + 1] ?? null);
})();
const KEEP = process.env.KEEP_SMOKE_DIR === '1';

// No @nestjs/*, no reflect-metadata. drizzle-orm pinned exactly to the repo's own (one identity).
const RUNTIME_DEPS = ['drizzle-orm@1.0.0-rc.4', 'pg@8', 'zod@4', `@pattern-stack/wiring@file:${path.join(REPO_ROOT, 'packages', 'wiring')}`];
const DEV_DEPS = ['typescript@5', 'drizzle-kit@1.0.0-rc.4', '@types/bun', '@types/pg@8'];

const t0 = Date.now();
const log = (msg: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const fail = (msg: string): never => {
	throw new Error(msg);
};

function run(cmd: string, cwd: string): void {
	log(`$ ${cmd}`);
	execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, FORCE_COLOR: '0' } });
}

function walk(dir: string, skip: (p: string) => boolean = () => false): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		if (skip(p)) return [];
		return e.isDirectory() ? walk(p, skip) : [p];
	});
}

const NEST_IMPORT = /from\s+['"](@nestjs\/[^'"]+|reflect-metadata)['"]|import\s+['"](@nestjs\/[^'"]+|reflect-metadata)['"]/;

function sourceFiles(tmpDir: string): string[] {
	return walk(tmpDir, (p) => p.includes(`${path.sep}node_modules`) || p.includes(`${path.sep}.git`)).filter((f) =>
		/\.(ts|tsx|mts|cts)$/.test(f),
	);
}

async function main(): Promise<number> {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegen-smoke-pattern-stack-'));
	log(`tmp dir: ${tmpDir}`);
	try {
		// 1. Project + deps, without Nest. `@pattern-stack/wiring` installs from this checkout as a consumer gets it:
		// built (its `types` export is `dist/`).
		run('bun run build', path.join(REPO_ROOT, 'packages', 'wiring'));
		run('bun init -y', tmpDir);
		run(`bun add ${RUNTIME_DEPS.join(' ')}`, tmpDir);
		run(`bun add -D ${DEV_DEPS.join(' ')}`, tmpDir);

		// 2. Init for pattern-stack wiring (PW-4): nothing to delete, nothing to rewrite.
		run(`${CLI} project init --yes --with-tsconfig --runtime vendored --wiring pattern-stack`, tmpDir);
		const config = fs.readFileSync(path.join(tmpDir, 'codegen.config.yaml'), 'utf8');
		if (!/^target:\n(?:[ \t]+.*\n)*?[ \t]+wiring: pattern-stack\n/m.test(config)) fail(`init should write target.wiring: pattern-stack:\n${config}`);
		const initLeaks = sourceFiles(tmpDir).filter((f) => NEST_IMPORT.test(fs.readFileSync(f, 'utf8')));
		if (initLeaks.length > 0) fail(`init wrote files that import @nestjs:\n  ${initLeaks.map((f) => path.relative(tmpDir, f)).join('\n  ')}`);
		for (const f of ['src/database.ts', 'src/compose.ts', 'src/main.ts', 'src/generated/wiring.ts', 'src/generated/composition.ts']) {
			if (!fs.existsSync(path.join(tmpDir, f))) fail(`init should write ${f}`);
		}
		for (const f of ['src/app.module.ts', 'src/shared/database/database.module.ts', 'src/generated/modules.ts', 'src/shared/nest-logger.ts']) {
			if (fs.existsSync(path.join(tmpDir, f))) fail(`init should not write ${f} under pattern-stack wiring`);
		}
		log('init: target.wiring pattern-stack; database.ts, compose.ts, main.ts, the empty composition; no Nest scaffold');

		// 3. Decorators: init turned neither on.
		const tsconfig = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tsconfig.json'), 'utf8'));
		for (const opt of ['experimentalDecorators', 'emitDecoratorMetadata']) {
			if (tsconfig.compilerOptions?.[opt] === true) fail(`init turned on ${opt} under pattern-stack wiring`);
		}
		// The project compiles before any entity: main.ts and compose.ts over the empty composition.
		const tscEmpty = spawnSync('bunx', ['tsc', '--noEmit', '--skipLibCheck'], { cwd: tmpDir, encoding: 'utf8' });
		const emptyErrors = tscGateErrors({ code: tscEmpty.status, output: (tscEmpty.stdout ?? '') + (tscEmpty.stderr ?? '') }, tmpDir);
		if (emptyErrors.length > 0) {
			for (const line of emptyErrors) console.error(line);
			fail(`${emptyErrors.length} typecheck errors in the freshly initialized project`);
		}
		log('tsconfig: no decorators; the fresh project compiles before any entity');

		// 4. Fixtures, then generate.
		const entitiesDir = path.join(tmpDir, 'entities');
		fs.mkdirSync(entitiesDir, { recursive: true });
		for (const f of fs.readdirSync(FIXTURES_DIR).filter((n) => n.endsWith('.yaml'))) {
			fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(entitiesDir, f));
		}
		// PW-3c: a junction inside crm (account ↔ tag).
		const junctionsDir = path.join(tmpDir, 'junctions');
		fs.mkdirSync(junctionsDir, { recursive: true });
		for (const f of fs.readdirSync(JUNCTIONS_DIR).filter((n) => n.endsWith('.yaml'))) {
			fs.copyFileSync(path.join(JUNCTIONS_DIR, f), path.join(junctionsDir, f));
		}
		run(`${CLI} entity new --all --force`, tmpDir);
		run(`${CLI} junction new --all --force`, tmpDir);
		// The consumer's usage, compiled with the project: every key it reads is the composition's real API.
		fs.copyFileSync(USAGE_FILE, path.join(tmpDir, 'src', 'crud-check.ts'));
		fs.copyFileSync(path.join(import.meta.dirname, '_openapi-refs.ts'), path.join(tmpDir, 'src', 'openapi-refs.ts'));

		// 5a. Nest-free: no import of it anywhere, and none installed.
		const leaks = sourceFiles(tmpDir).filter((f) => NEST_IMPORT.test(fs.readFileSync(f, 'utf8')));
		if (leaks.length > 0) fail(`files import @nestjs or reflect-metadata:\n  ${leaks.map((f) => path.relative(tmpDir, f)).join('\n  ')}`);
		for (const pkg of ['@nestjs', 'reflect-metadata']) {
			if (fs.existsSync(path.join(tmpDir, 'node_modules', pkg))) fail(`node_modules/${pkg} is installed`);
		}
		log('no @nestjs / reflect-metadata imported or installed');

		// 5b. The composition.
		const generated = sourceFiles(tmpDir).map((f) => path.relative(tmpDir, f));
		const expectOne = (suffix: string) => {
			if (!generated.some((f) => f.endsWith(suffix))) fail(`expected a generated file ending ${suffix}`);
		};
		for (const s of ['/crm/module.ts', '/billing/module.ts', 'modules/module.ts', '/wiring.ts', '/composition.ts', 'generated/openapi.ts']) expectOne(s);
		for (const s of ['/account.wiring.ts', '/contact.wiring.ts', '/invoice.wiring.ts', '/note.wiring.ts', '/person.wiring.ts']) expectOne(s);
		const billing = fs.readFileSync(path.join(tmpDir, generated.find((f) => f.endsWith('/billing/module.ts'))!), 'utf8');
		if (!/dependsOn: \['crm'\]/.test(billing)) fail("billing's module should dependsOn ['crm'] (invoice belongs_to account)");
		for (const s of ['.controller.ts', '.module.ts']) {
			const nest = generated.filter((f) => f.endsWith(s) && !f.endsWith('/module.ts'));
			if (nest.length > 0) fail(`wiring: pattern-stack emitted Nest-only files: ${nest.join(', ')}`);
		}
		log('composition files present; billing dependsOn crm; no controllers or Nest modules');

		// 5c. tsc, scoped by location only.
		log('running bunx tsc --noEmit --skipLibCheck');
		const tsc = spawnSync('bunx', ['tsc', '--noEmit', '--skipLibCheck'], { cwd: tmpDir, encoding: 'utf8' });
		const errors = tscGateErrors({ code: tsc.status, output: (tsc.stdout ?? '') + (tsc.stderr ?? '') }, tmpDir);
		if (errors.length > 0) {
			for (const line of errors) console.error(line);
			fail(`${errors.length} typecheck errors in the pattern-stack project`);
		}
		log('tsc OK: the pattern-stack project compiles with no @nestjs and decorators off');

		// 5c'. main.ts composes, starts, runs and stops (no database needed: the pool connects on first use).
		const main = spawnSync('bun', ['src/main.ts'], { cwd: tmpDir, encoding: 'utf8' });
		if (main.status !== 0) fail(`bun src/main.ts exited ${main.status}:\n${main.stdout}${main.stderr}`);
		if (!/composed: database, .*crm.*billing/.test(main.stdout)) fail(`main.ts should print the composed order: ${main.stdout}`);
		log(`main.ts: ${main.stdout.trim()}`);

		// 5d. The OpenAPI document needs no database: every schema registers, every $ref resolves, every prefill parses.
		run('bun src/crud-check.ts --openapi', tmpDir);
		log('openapi.ts: every entity\'s schemas register; no dangling $ref; request prefills parse');

		// 6. Boot and CRUD on Postgres (integration job only).
		if (POSTGRES_URL) {
			const dbName = `pattern_stack_smoke_${process.pid}`;
			const admin = (sql: string) =>
				run(`bun -e "const { Client } = require('pg'); const c = new Client({ connectionString: process.argv[1] }); await c.connect(); await c.query(process.argv[2]); await c.end();" '${POSTGRES_URL}' '${sql}'`, tmpDir);
			admin(`CREATE DATABASE ${dbName}`);
			const dbUrl = POSTGRES_URL.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`);
			try {
				execSync('bunx drizzle-kit push --force', { cwd: tmpDir, stdio: 'inherit', env: { ...process.env, DATABASE_URL: dbUrl } });
				log('schema pushed');
				run(`bun src/crud-check.ts '${dbUrl}'`, tmpDir);
				log('CRUD through the composed use cases OK (create, findById, list, query, update, delete, NotFoundError)');
			} finally {
				admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
			}
		}
		console.log('\nPASS — pattern-stack wiring smoke');
		return 0;
	} catch (err) {
		console.error(`\nFAIL — ${(err as Error).message}`);
		return 1;
	} finally {
		if (KEEP) log(`kept ${tmpDir}`);
		else fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

process.exit(await main());
