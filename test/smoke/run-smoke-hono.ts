#!/usr/bin/env bun
/**
 * Hono smoke (H-1b): a project with `target: { wiring: pattern-stack, http: hono }` compiles with no `@nestjs/*`
 * package, serves its routes, and answers as the Nest target does.
 *
 * 1. A fresh tmp project: the pattern-stack runtime deps, plus `hono` and `@hono/node-server` (the layer's row).
 * 2. `codegen project init --runtime vendored --wiring pattern-stack --http hono`: the config's target, a `main.ts`
 *    that serves `createApp`, and `<generated>/http.ts` over no entity yet. The project compiles here.
 * 3. Two fixtures from the pattern-stack smoke (`account`, `contact`) through `entity new --all`.
 * 4. Gates:
 *    - no file imports `@nestjs/*` or `reflect-metadata`;
 *    - each entity has `.routes.ts` and `.commands.ts`, and `<generated>/http.ts` mounts them;
 *    - `tsc` over the project, scoped by location only (`_consumer-errors.ts`), like every smoke;
 *    - `bun src/main.ts` serves on the `http.port` setting (an unknown route answers Nest's 404) and stops on SIGTERM (no database).
 * 5. `--postgres <url>` (the integration job): push the schema into a fresh database and run the request script
 *    (`fixtures-hono-usage/http-check.ts`): each status and body as the Nest target sends it.
 */

import { execSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tscGateErrors } from './_consumer-errors';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = `bun ${path.join(REPO_ROOT, 'src', 'cli', 'index.ts')}`;
const FIXTURES = ['account.yaml', 'contact.yaml'].map((f) => path.join(import.meta.dirname, 'fixtures-pattern-stack', f));
const USAGE_FILE = path.join(import.meta.dirname, 'fixtures-hono-usage', 'http-check.ts');
const POSTGRES_URL = (() => {
	const i = process.argv.indexOf('--postgres');
	return i === -1 ? null : (process.argv[i + 1] ?? null);
})();
const KEEP = process.env.KEEP_SMOKE_DIR === '1';

const RUNTIME_DEPS = [
	'drizzle-orm@1.0.0-rc.4',
	'pg@8',
	'zod@4',
	'hono@4',
	'@hono/node-server@1',
	`@pattern-stack/wiring@file:${path.join(REPO_ROOT, 'packages', 'wiring')}`,
];
const DEV_DEPS = ['typescript@5', 'drizzle-kit@1.0.0-rc.4', '@types/bun', '@types/pg@8'];
const NEST_IMPORT = /from ['"](@nestjs\/|reflect-metadata)/;

const t0 = Date.now();
const log = (msg: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const fail = (msg: string): never => {
	throw new Error(msg);
};

function run(cmd: string, cwd: string): void {
	log(`$ ${cmd}`);
	execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, FORCE_COLOR: '0' } });
}

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...sourceFiles(p));
		else if (p.endsWith('.ts')) out.push(p);
	}
	return out;
}

function typecheck(tmpDir: string, what: string): void {
	const tsc = spawnSync('bunx', ['tsc', '--noEmit', '--skipLibCheck'], { cwd: tmpDir, encoding: 'utf8' });
	const errors = tscGateErrors({ code: tsc.status, output: (tsc.stdout ?? '') + (tsc.stderr ?? '') }, tmpDir);
	if (errors.length > 0) {
		for (const line of errors) console.error(line);
		fail(`${errors.length} typecheck errors in ${what}`);
	}
}

/** `bun src/main.ts` on a free port: it answers, then stops cleanly on SIGTERM. */
async function serveAndStop(tmpDir: string): Promise<void> {
	const port = 20000 + (process.pid % 20000);
	const child = spawn('bun', ['src/main.ts'], { cwd: tmpDir, env: { ...process.env, PORT: String(port) } });
	let out = '';
	child.stdout.on('data', (d) => (out += String(d)));
	child.stderr.on('data', (d) => (out += String(d)));
	const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
	try {
		for (let i = 0; i < 100 && !out.includes('listening on'); i++) await new Promise((r) => setTimeout(r, 100));
		if (!out.includes(`listening on http://localhost:${port}`)) fail(`main.ts should listen on PORT ${port}: ${out}`);
		// No database here, so an unknown route (Nest's 404 body) shows the server answers; the document is off by default.
		const res = await fetch(`http://localhost:${port}/nope`);
		if (res.status !== 404) fail(`GET /nope on the served app is ${res.status}`);
		const body = (await res.json()) as { message?: string };
		if (body.message !== 'Cannot GET /nope') fail(`the served 404 should be Nest's: ${JSON.stringify(body)}`);
	} finally {
		child.kill('SIGTERM');
	}
	const code = await exited;
	if (code !== 0) fail(`main.ts should stop cleanly on SIGTERM (exit ${code}): ${out}`);
	log(`main.ts served on ${port} (Nest's 404 for an unknown route) and stopped on SIGTERM`);
}

async function main(): Promise<number> {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegen-smoke-hono-'));
	log(`tmp dir: ${tmpDir}`);
	try {
		run('bun run build', path.join(REPO_ROOT, 'packages', 'wiring'));
		run('bun init -y', tmpDir);
		run(`bun add ${RUNTIME_DEPS.join(' ')}`, tmpDir);
		run(`bun add -D ${DEV_DEPS.join(' ')}`, tmpDir);
		for (const f of ['index.ts']) fs.rmSync(path.join(tmpDir, f), { force: true });

		// 2. init with the Hono layer.
		run(`${CLI} project init --yes --with-tsconfig --runtime vendored --wiring pattern-stack --http hono`, tmpDir);
		const config = fs.readFileSync(path.join(tmpDir, 'codegen.config.yaml'), 'utf8');
		if (!/^[ \t]+http: hono$/m.test(config)) fail(`init should write target.http: hono:\n${config}`);
		const mainTs = fs.readFileSync(path.join(tmpDir, 'src/main.ts'), 'utf8');
		if (!mainTs.includes('createApp(app)') || !mainTs.includes("from '@hono/node-server'")) fail(`main.ts should serve createApp:\n${mainTs}`);
		for (const f of ['src/generated/http.ts', 'src/shared/http/hono.ts', 'src/shared/commands.ts']) {
			if (!fs.existsSync(path.join(tmpDir, f))) fail(`init should write ${f}`);
		}
		const envExample = fs.readFileSync(path.join(tmpDir, '.env.example'), 'utf8');
		if (!/# PORT=3000/.test(envExample)) fail(`.env.example should list the http.port setting:\n${envExample}`);
		typecheck(tmpDir, 'the freshly initialized project');
		log('init: target.http hono; main.ts serves createApp; http.ts over no entity; PORT in .env.example; compiles');

		// 3. Entities.
		const entitiesDir = path.join(tmpDir, 'entities');
		fs.mkdirSync(entitiesDir, { recursive: true });
		for (const f of FIXTURES) fs.copyFileSync(f, path.join(entitiesDir, path.basename(f)));
		fs.copyFileSync(USAGE_FILE, path.join(tmpDir, 'src', 'http-check.ts'));
		run(`${CLI} entity new --all`, tmpDir);

		// 4a. Nest-free.
		const leaks = sourceFiles(tmpDir).filter((f) => NEST_IMPORT.test(fs.readFileSync(f, 'utf8')));
		if (leaks.length > 0) fail(`files import @nestjs or reflect-metadata:\n  ${leaks.map((f) => path.relative(tmpDir, f)).join('\n  ')}`);
		// 4b. The routes, and http.ts mounting them.
		const generated = sourceFiles(tmpDir).map((f) => path.relative(tmpDir, f));
		for (const s of ['/account.routes.ts', '/contact.routes.ts', '/account.commands.ts', '/contact.commands.ts']) {
			if (!generated.some((f) => f.endsWith(s))) fail(`expected a generated file ending ${s}`);
		}
		const httpTs = fs.readFileSync(path.join(tmpDir, 'src/generated/http.ts'), 'utf8');
		for (const mount of ["accountRoutes(app.module('crm').account.useCases)", "contactRoutes(app.module('crm').contact.useCases)"]) {
			if (!httpTs.includes(mount)) fail(`http.ts should mount ${mount}:\n${httpTs}`);
		}
		const accountRoutes = fs.readFileSync(path.join(tmpDir, generated.find((f) => f.endsWith('/account.routes.ts'))!), 'utf8');
		const searchAt = accountRoutes.indexOf("'/accounts/search'");
		const idAt = accountRoutes.indexOf("'/accounts/:id'");
		if (searchAt === -1 || idAt === -1) fail(`account.routes.ts should have both /accounts/search and /accounts/:id:\n${accountRoutes}`);
		if (searchAt > idAt) fail('the search route should be registered before /accounts/:id');
		log('routes and commands per entity; http.ts mounts them; search before /:id');
		// 4c. tsc.
		typecheck(tmpDir, 'the Hono project');
		log('tsc OK: the Hono project compiles with no @nestjs');
		// 4d. Serve and stop.
		await serveAndStop(tmpDir);

		// 5. On Postgres.
		if (POSTGRES_URL) {
			const dbName = `hono_smoke_${process.pid}`;
			const admin = (sql: string) =>
				run(`bun -e "const { Client } = require('pg'); const c = new Client({ connectionString: process.argv[1] }); await c.connect(); await c.query(process.argv[2]); await c.end();" '${POSTGRES_URL}' '${sql}'`, tmpDir);
			admin(`CREATE DATABASE ${dbName}`);
			const dbUrl = POSTGRES_URL.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`);
			try {
				execSync('bunx drizzle-kit push --force', { cwd: tmpDir, stdio: 'inherit', env: { ...process.env, DATABASE_URL: dbUrl } });
				run(`bun src/http-check.ts '${dbUrl}'`, tmpDir);
				log('HTTP on Postgres: every status and body as the Nest target sends it');
			} finally {
				admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
			}
		}
		console.log('\nPASS — Hono smoke');
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
