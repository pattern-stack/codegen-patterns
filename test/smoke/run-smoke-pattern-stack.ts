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

import { execSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tscGateErrors } from './_consumer-errors';
import { addJobsPackage } from './_package-runtime';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = `bun ${path.join(REPO_ROOT, 'src', 'cli', 'index.ts')}`;
const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures-pattern-stack');
/** PW-3c: the junctions, a sibling folder so the entity loaders never read them as entities. */
const JUNCTIONS_DIR = path.join(import.meta.dirname, 'fixtures-pattern-stack-junctions');
const USAGE_FILE = path.join(import.meta.dirname, 'fixtures-pattern-stack-usage', 'crud-check.ts');
/** J-1: the jobs check (the bridge, the kill and restart) and the jobs it runs, copied into `src/` and `src/jobs/`. */
const JOBS_USAGE_FILE = path.join(import.meta.dirname, 'fixtures-pattern-stack-usage', 'jobs-check.ts');
const JOBS_FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures-pattern-stack-jobs');
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

/**
 * J-1's restart proof: a process starts `smoke.slow` and is killed (SIGKILL, no stop) inside its second step; a new
 * process composes, sweeps the run once its lease lapses, and completes it without running the first step again.
 */
async function killAndResume(tmpDir: string, dbUrl: string): Promise<void> {
	const marker = path.join(tmpDir, 'slow-run');
	const child = spawn('bun', ['src/jobs-check.ts', 'start-slow', dbUrl, marker], { cwd: tmpDir, stdio: ['ignore', 'pipe', 'inherit'] });
	let out = '';
	child.stdout.on('data', (b: Buffer) => (out += b.toString()));
	const deadline = Date.now() + 30_000;
	while (!(/run (\S+)/.test(out) && fs.existsSync(`${marker}.attempts`))) {
		if (Date.now() > deadline || child.exitCode !== null) {
			child.kill('SIGKILL');
			fail(`the slow run never reached its second step (exit ${child.exitCode}): ${out}`);
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	const runId = /run (\S+)/.exec(out)![1]!;
	child.kill('SIGKILL');
	await new Promise((r) => child.once('exit', r));
	log(`killed the process running ${runId} inside its second step`);
	run(`bun src/jobs-check.ts resume '${dbUrl}' '${marker}' ${runId}`, tmpDir);
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
		// J-1: @pattern-stack/jobs as a consumer gets it (packed from this checkout); its Nest peers are optional.
		addJobsPackage(tmpDir, run);

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

		// 3b. Events (S-1): the drizzle backend, vendored Nest-free (no events.module.ts, no Nest barrel).
		run(`${CLI} subsystem install events --yes`, tmpDir);
		// The empty generated set, Nest-free, so a composition written before the first `entity new` resolves its import.
		for (const f of ['src/shared/subsystems/events/core.ts', 'src/shared/subsystems/events/event-bus.drizzle-backend.ts', 'src/shared/subsystems/events/generated/bus.ts']) {
			if (!fs.existsSync(path.join(tmpDir, f))) fail(`subsystem install events should vendor ${f}`);
		}
		for (const f of ['src/shared/subsystems/events/events.module.ts', 'src/shared/subsystems/events/index.ts', 'src/generated/subsystems.ts']) {
			if (fs.existsSync(path.join(tmpDir, f))) fail(`subsystem install events should not write ${f} under pattern-stack wiring`);
		}
		log('events installed: the Nest-free closure, no Nest module or barrel');

		// 3c. Integration (S-3): the drizzle backend, vendored Nest-free (no module, no barrel, no Nest use case).
		run(`${CLI} subsystem install integration --yes`, tmpDir);
		for (const f of ['core.ts', 'integration-runner.ts', 'integration-cursor-store.drizzle-backend.ts', 'integration-audit.schema.ts']) {
			if (!fs.existsSync(path.join(tmpDir, 'src/shared/subsystems/integration', f))) fail(`subsystem install integration should vendor ${f}`);
		}
		for (const f of ['integration.module.ts', 'index.ts', 'execute-integration.use-case.ts']) {
			if (fs.existsSync(path.join(tmpDir, 'src/shared/subsystems/integration', f))) {
				fail(`subsystem install integration should not write ${f} under pattern-stack wiring`);
			}
		}
		log('integration installed: the Nest-free closure, no Nest module, barrel or use case');
		// 3d. Jobs and the bridge (J-1): vendored Nest-free; no worker.ts, no main.ts hook.
		run(`${CLI} subsystem install jobs --yes`, tmpDir);
		run(`${CLI} subsystem install bridge --yes`, tmpDir);
		for (const f of ['jobs/core.ts', 'jobs/jobs-engine.ts', 'jobs/job-run-starter.ts', 'bridge/core.ts', 'bridge/bridge-outbox-drainer.ts', 'bridge/generated/registry.ts']) {
			if (!fs.existsSync(path.join(tmpDir, 'src/shared/subsystems', f))) fail(`subsystem install jobs / bridge should vendor ${f}`);
		}
		for (const f of ['shared/subsystems/jobs/jobs-engine.module.ts', 'shared/subsystems/jobs/job-starter.ts', 'shared/subsystems/jobs/index.ts', 'shared/subsystems/bridge/bridge.module.ts', 'shared/subsystems/bridge/index.ts', 'worker.ts']) {
			if (fs.existsSync(path.join(tmpDir, 'src', f))) fail(`subsystem install jobs / bridge should not write src/${f} under pattern-stack wiring`);
		}
		if (!fs.existsSync(path.join(tmpDir, 'src/generated/jobs.ts'))) fail('subsystem install jobs should write the job registry');
		// A short lease and a quick sweep, so the Postgres leg's restarted process resumes the killed run in seconds.
		const configPath = path.join(tmpDir, 'codegen.config.yaml');
		const withJobs = fs.readFileSync(configPath, 'utf8').replace(/^(  worker_mode: .*)$/m, '$1\n  poll_interval_ms: 100\n  open_sweep_every: 5\n  lease_ttl_ms: 2000');
		if (!/lease_ttl_ms: 2000/.test(withJobs)) fail('the jobs config block should have a worker_mode line to extend');
		fs.writeFileSync(configPath, withJobs);
		const jobsDir = path.join(tmpDir, 'src', 'jobs');
		fs.mkdirSync(jobsDir, { recursive: true });
		for (const f of fs.readdirSync(JOBS_FIXTURES_DIR).filter((n) => n.endsWith('.ts'))) fs.copyFileSync(path.join(JOBS_FIXTURES_DIR, f), path.join(jobsDir, f));
		log('jobs and bridge installed: the Nest-free closure, no Nest module, barrel or worker.ts; the smoke jobs in src/jobs/');

		// 3d. Auth (S-2): drizzle, vendored Nest-free (no module, barrel, controller, guard or middleware), then the
		// connections starter without its Nest module. The key lands in .env.config, which the settings system reads.
		run(`${CLI} subsystem install auth --yes`, tmpDir);
		for (const f of ['core.ts', 'auth-oauth-state.schema.ts', 'backends/state-store.drizzle-backend.ts', 'runtime/oauth-callback-url.ts']) {
			if (!fs.existsSync(path.join(tmpDir, 'src/shared/subsystems/auth', f))) fail(`subsystem install auth should vendor ${f}`);
		}
		for (const f of ['auth.module.ts', 'index.ts', 'controllers/auth.controller.ts', 'guards/authenticated.guard.ts', 'guards/public.decorator.ts', 'middleware/requester-context.ts']) {
			if (fs.existsSync(path.join(tmpDir, 'src/shared/subsystems/auth', f))) fail(`subsystem install auth should not write ${f} under pattern-stack wiring`);
		}
		if (!/INTEGRATION_TOKEN_ENCRYPTION_KEY=/.test(fs.readFileSync(path.join(tmpDir, '.env.config'), 'utf8'))) {
			fail('subsystem install auth should write INTEGRATION_TOKEN_ENCRYPTION_KEY to .env.config');
		}
		if (fs.existsSync(path.join(tmpDir, 'src/app.module.ts'))) fail('subsystem install auth should not write app.module.ts under pattern-stack wiring');
		run(`${CLI} subsystem install auth-integrations --yes`, tmpDir);
		for (const f of ['connection-store.ts', 'connection-rows.ts', 'adapters/connection-reader.adapter.ts', 'facade/connections.service.ts']) {
			if (!fs.existsSync(path.join(tmpDir, 'src/modules/connections', f))) fail(`subsystem install auth-integrations should vendor ${f}`);
		}
		if (fs.existsSync(path.join(tmpDir, 'src/modules/connections/connections-auth.module.ts'))) {
			fail('subsystem install auth-integrations should not write connections-auth.module.ts under pattern-stack wiring');
		}
		const storeText = fs.readFileSync(path.join(tmpDir, 'src/modules/connections/connection-store.ts'), 'utf8');
		if (!storeText.includes("from '../../shared/subsystems/auth/core'")) fail(`the starter should import the Nest-free auth entry:\n${storeText}`);
		log('auth + auth-integrations installed: the Nest-free closure, no Nest module, barrel, controller, guard or middleware');

		// 3e. Identity (ID-1): the runtime (Nest-free, the requester port with it), three entity YAMLs, the identity: block,
		// the tenant column, and the principal source, which the smoke replaces with a header-reading one.
		run(`${CLI} subsystem install identity --yes`, tmpDir);
		for (const f of ['subsystems/identity/core.ts', 'subsystems/identity/requester-cache.postgres-backend.ts', 'requester.ts', 'subsystems/events/pg-notify.ts']) {
			if (!fs.existsSync(path.join(tmpDir, 'src/shared', f))) fail(`subsystem install identity should vendor ${f}`);
		}
		for (const f of ['user.yaml', 'workspace.yaml', 'membership.yaml']) {
			if (!fs.existsSync(path.join(tmpDir, 'entities/identity', f))) fail(`subsystem install identity should vendor entities/identity/${f}`);
		}
		const identityConfig = fs.readFileSync(path.join(tmpDir, 'codegen.config.yaml'), 'utf8');
		if (!/^identity:\n(?:.*\n)*?  workspace_from: header\n/m.test(identityConfig)) fail(`the identity: block is missing:\n${identityConfig}`);
		if (!/^tenancy:\n(?:.*\n)*?  column: workspace_id\n/m.test(identityConfig)) fail(`tenancy.column should be workspace_id:\n${identityConfig}`);
		const principalScaffold = path.join(tmpDir, 'src/identity/principal-source.ts');
		if (!/principalOf: async \(\) => null/.test(fs.readFileSync(principalScaffold, 'utf8'))) fail('the principal source scaffold should let nobody in');
		fs.copyFileSync(path.join(import.meta.dirname, 'fixtures-pattern-stack-usage', 'principal-source.ts'), principalScaffold);
		log('identity installed: the Nest-free runtime, user/workspace/membership, the identity: block, tenancy.column, the principal source');

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
		fs.copyFileSync(JOBS_USAGE_FILE, path.join(tmpDir, 'src', 'jobs-check.ts'));
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
		for (const s of ['/crm/module.ts', '/billing/module.ts', 'modules/module.ts', '/wiring.ts', '/composition.ts', 'generated/openapi.ts', 'generated/events-system.ts', 'generated/integration-system.ts', 'generated/auth-system.ts', 'generated/connections-system.ts', 'generated/requester-system.ts', 'generated/workspaces-module.ts', '/identity/module.ts', 'events/generated/bus.ts', 'generated/jobs-system.ts', 'generated/job-deps.ts', 'generated/jobs.ts']) expectOne(s);
		// J-1: the jobDeps module provides the factory's two modules, typed; the events system drains through the bridge.
		const jobDeps = fs.readFileSync(path.join(tmpDir, 'src/generated/job-deps.ts'), 'utf8');
		if (!/dependsOn: \['billing', 'crm'\]/.test(jobDeps)) fail(`jobDeps should dependsOn the modules the factory names:\n${jobDeps}`);
		if (!jobDeps.includes('deps.jobs.provide(invoiceFollowUp, { billing: deps.billing, crm: deps.crm });')) fail(`jobDeps should provide invoiceFollowUp:\n${jobDeps}`);
		const eventsSystem = fs.readFileSync(path.join(tmpDir, 'src/generated/events-system.ts'), 'utf8');
		if (!/uses: \['database', 'jobs'\]/.test(eventsSystem) || !eventsSystem.includes('new BridgeOutboxDrainer(jobs.starter, deliveries, bridgeRegistry)')) {
			fail(`the events system should pass the bridge's drain to its bus:\n${eventsSystem}`);
		}
		const bridgeRegistry = fs.readFileSync(path.join(tmpDir, 'src/shared/subsystems/bridge/generated/registry.ts'), 'utf8');
		if (!/invoice_created/.test(bridgeRegistry) || !/invoice\.follow_up/.test(bridgeRegistry)) fail(`the bridge registry should carry the trigger:\n${bridgeRegistry}`);
		for (const s of ['/account.wiring.ts', '/contact.wiring.ts', '/invoice.wiring.ts', '/note.wiring.ts', '/person.wiring.ts']) expectOne(s);
		const billing = fs.readFileSync(path.join(tmpDir, generated.find((f) => f.endsWith('/billing/module.ts'))!), 'utf8');
		if (!/dependsOn: \['crm'\]/.test(billing)) fail("billing's module should dependsOn ['crm'] (invoice belongs_to account)");
		if (!/uses: \['database', 'events'\]/.test(billing)) fail("billing's module should use the events system (invoice emits invoice_created)");
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
		// No database here, so this process runs no executor loop (JOBS_WORKER=false): it composes, starts and stops.
		const main = spawnSync('bun', ['src/main.ts'], { cwd: tmpDir, encoding: 'utf8', env: { ...process.env, JOBS_WORKER: 'false' } });
		if (main.status !== 0) fail(`bun src/main.ts exited ${main.status}:\n${main.stdout}${main.stderr}`);
		if (!/composed: settings, database, jobs, events, integration, auth, connections, requester, .*crm.*billing.*jobDeps/.test(main.stdout) || !/\bworkspaces\b/.test(main.stdout)) {
			fail(`main.ts should print the composed order: ${main.stdout}`);
		}
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
				log('CRUD through the composed use cases OK (create, findById, list, query, update, delete, NotFoundError); an integration run on the integration system; OAuth state, a stored grant and a refresh on the auth and connections systems; workspaces, membership and the requester, evicted across apps and cleared on reconnect');
				// J-1: an event starts a job and its step completes; then a process killed mid-step, and a restart that resumes it.
				run(`bun src/jobs-check.ts bridge '${dbUrl}'`, tmpDir);
				await killAndResume(tmpDir, dbUrl);
				log('jobs: invoice_created started invoice.follow_up through the bridge, and it completed; a run killed mid-step resumed in a new process');
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
