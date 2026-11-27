#!/usr/bin/env bun
/**
 * Plain-wiring smoke (PW-3): a project with `target: { wiring: plain, http: none }` compiles with NO `@nestjs/*`
 * package, no `reflect-metadata`, and decorators off.
 *
 * 1. A fresh tmp project: `bun init`, then the runtime deps WITHOUT Nest, and `@pattern-stack/wiring` from this
 *    checkout's `packages/wiring` (PW-2).
 * 2. `codegen project init --runtime vendored`, then the target set to plain. `project init` for plain is PW-4; until
 *    it lands, init still writes the Nest scaffold, so this harness deletes every scaffolded file that imports
 *    `@nestjs` BEFORE generating, naming each. Nothing `entity new` writes is exempt.
 * 3. `tsconfig.json`: `experimentalDecorators` and `emitDecoratorMetadata` off.
 * 4. The fixtures in `test/smoke/fixtures-plain/` (two contexts, a cross-context `belongs_to`, a mutual composition,
 *    a root entity) through `entity new --all`.
 * 5. Gates:
 *    - no file in the project imports `@nestjs/*` or `reflect-metadata`, and `node_modules` has neither;
 *    - the composition files exist (one `module.ts` per context, `<generated>/wiring.ts`, `<generated>/composition.ts`);
 *    - `tsc` over the project, scoped by location only (`_consumer-errors.ts`), like every smoke.
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
const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures-plain');
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
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegen-smoke-plain-'));
	log(`tmp dir: ${tmpDir}`);
	try {
		// 1. Project + deps, without Nest. `@pattern-stack/wiring` installs from this checkout as a consumer gets it:
		// built (its `types` export is `dist/`).
		run('bun run build', path.join(REPO_ROOT, 'packages', 'wiring'));
		run('bun init -y', tmpDir);
		run(`bun add ${RUNTIME_DEPS.join(' ')}`, tmpDir);
		run(`bun add -D ${DEV_DEPS.join(' ')}`, tmpDir);

		// 2. Init, then plain; the Nest scaffold out (PW-4 makes init write none).
		run(`${CLI} project init --yes --with-tsconfig --runtime vendored`, tmpDir);
		const configPath = path.join(tmpDir, 'codegen.config.yaml');
		const config = fs.readFileSync(configPath, 'utf8');
		const targetLine = /^target:.*\n(?:[ \t]+.*\n)*/m;
		const plainTarget = 'target:\n  database: postgres\n  orm: drizzle\n  wiring: plain\n  http: none\n';
		fs.writeFileSync(configPath, targetLine.test(config) ? config.replace(targetLine, plainTarget) : `${config.trimEnd()}\n\n${plainTarget}`);
		log('set target: { wiring: plain, http: none }');
		const nestScaffold = sourceFiles(tmpDir).filter((f) => NEST_IMPORT.test(fs.readFileSync(f, 'utf8')));
		for (const f of nestScaffold) {
			fs.rmSync(f);
			log(`removed Nest scaffold (PW-4 stops writing it): ${path.relative(tmpDir, f)}`);
		}

		// 3. Decorators off.
		const tsconfigPath = path.join(tmpDir, 'tsconfig.json');
		const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
		tsconfig.compilerOptions = { ...tsconfig.compilerOptions, experimentalDecorators: false, emitDecoratorMetadata: false };
		fs.writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);
		log('tsconfig: experimentalDecorators and emitDecoratorMetadata off');

		// 4. Fixtures, then generate.
		const entitiesDir = path.join(tmpDir, 'entities');
		fs.mkdirSync(entitiesDir, { recursive: true });
		for (const f of fs.readdirSync(FIXTURES_DIR).filter((n) => n.endsWith('.yaml'))) {
			fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(entitiesDir, f));
		}
		run(`${CLI} entity new --all --force`, tmpDir);

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
		for (const s of ['/crm/module.ts', '/billing/module.ts', 'modules/module.ts', '/wiring.ts', '/composition.ts']) expectOne(s);
		for (const s of ['/account.wiring.ts', '/contact.wiring.ts', '/invoice.wiring.ts', '/note.wiring.ts']) expectOne(s);
		const billing = fs.readFileSync(path.join(tmpDir, generated.find((f) => f.endsWith('/billing/module.ts'))!), 'utf8');
		if (!/dependsOn: \['crm'\]/.test(billing)) fail("billing's module should dependsOn ['crm'] (invoice belongs_to account)");
		for (const s of ['.controller.ts', '.module.ts']) {
			const nest = generated.filter((f) => f.endsWith(s) && !f.endsWith('/module.ts'));
			if (nest.length > 0) fail(`wiring: plain emitted Nest-only files: ${nest.join(', ')}`);
		}
		log('composition files present; billing dependsOn crm; no controllers or Nest modules');

		// 5c. tsc, scoped by location only.
		log('running bunx tsc --noEmit --skipLibCheck');
		const tsc = spawnSync('bunx', ['tsc', '--noEmit', '--skipLibCheck'], { cwd: tmpDir, encoding: 'utf8' });
		const errors = tscGateErrors({ code: tsc.status, output: (tsc.stdout ?? '') + (tsc.stderr ?? '') }, tmpDir);
		if (errors.length > 0) {
			for (const line of errors) console.error(line);
			fail(`${errors.length} typecheck errors in the plain project`);
		}
		log('tsc OK: the plain project compiles with no @nestjs and decorators off');
		console.log('\nPASS — plain-wiring smoke');
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
