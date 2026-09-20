/**
 * Tests for the project noun — init scaffold planner, tsconfig merge,
 * and the NounModule summary/hints behavior.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import projectNoun from '../../cli/commands/project.js';
import {
	buildInitPlan,
	writePlan,
	mergeTsconfig,
	mergeFrontendDeps,
} from '../../cli/shared/init-scaffold.js';
import { loadContext } from '../../cli/shared/context.js';
import { projectLayout } from '../../cli/shared/project-layout.js';
import {
	FRONTEND_DEP_OVERRIDES,
	FRONTEND_EMITTED_DEPS,
	FRONTEND_LOCKSTEP_DEPS,
} from '../../emitters/frontend/deps.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let tempRoots: string[] = [];

function mkTempDir(prefix: string): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), `project-${prefix}-`));
	tempRoots.push(d);
	return d;
}

afterEach(() => {
	for (const r of tempRoots) {
		try {
			fs.rmSync(r, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
	tempRoots = [];
});

// ---------------------------------------------------------------------------
// NounModule shape
// ---------------------------------------------------------------------------

describe('project NounModule', () => {
	test('exports name=project with all eight commands', () => {
		expect(projectNoun.name).toBe('project');
		expect(projectNoun.commandClasses.length).toBe(8);
		expect(typeof projectNoun.summary).toBe('function');
		expect(typeof projectNoun.hints).toBe('function');
	});

	test('summary reports uninitialized for a fresh directory', async () => {
		const cwd = mkTempDir('unset');
		const ctx = await loadContext({ cwd, skipDetection: true });
		const pane = await projectNoun.summary(ctx);
		expect(pane.title).toBe('project');
		expect(Array.isArray(pane.body)).toBe(true);
		const body = (pane.body as string[]).join('\n');
		expect(body).toContain('not initialized');
	});

	test('hints include codegen init when uninitialized', async () => {
		const cwd = mkTempDir('unset2');
		const ctx = await loadContext({ cwd, skipDetection: true });
		const hints = await projectNoun.hints(ctx);
		expect(hints.some((h) => h.command.includes('init'))).toBe(true);
	});

	test('summary reports initialized when codegen.config.yaml exists', async () => {
		const cwd = mkTempDir('initialized');
		fs.writeFileSync(
			path.join(cwd, 'codegen.config.yaml'),
			'generate:\n  frontend: false\n'
		);
		const ctx = await loadContext({ cwd, skipDetection: true });
		const pane = await projectNoun.summary(ctx);
		const body = (pane.body as string[]).join('\n');
		expect(body).toContain('initialized');
		// backend is the only backend pipeline — nothing to report (ARCH-0).
		expect(body).not.toContain('architecture');
	});
});

// ---------------------------------------------------------------------------
// tsconfig merge
// ---------------------------------------------------------------------------

const DEFAULT_LAYOUT = projectLayout('/p', null);

describe('mergeTsconfig', () => {
	test('adds missing aliases to a minimal tsconfig', () => {
		const raw = JSON.stringify({ compilerOptions: {} });
		const res = mergeTsconfig(raw, DEFAULT_LAYOUT);
		expect(res.unchanged).toBe(false);
		expect(res.added).toContain('@shared/*');
		expect(res.added).toContain('@modules/*');
		expect(res.added).toContain('@generated/*');
		const parsed = JSON.parse(res.content);
		expect(parsed.compilerOptions.paths['@shared/*']).toEqual(['./src/shared/*']);
	});

	test('is idempotent — second merge reports unchanged', () => {
		const raw = JSON.stringify({ compilerOptions: {} });
		const once = mergeTsconfig(raw, DEFAULT_LAYOUT);
		const twice = mergeTsconfig(once.content, DEFAULT_LAYOUT);
		// Decorator flags were just set, so the second pass adds nothing
		// except the already-set ones that trigger unchanged=true.
		expect(twice.added).toHaveLength(0);
		expect(twice.unchanged).toBe(true);
	});

	test('does not clobber pre-existing aliases', () => {
		const raw = JSON.stringify({
			compilerOptions: {
				paths: { '@shared/*': ['./custom/shared/*'] },
			},
		});
		const res = mergeTsconfig(raw, DEFAULT_LAYOUT);
		const parsed = JSON.parse(res.content);
		// User's custom target is preserved
		expect(parsed.compilerOptions.paths['@shared/*']).toEqual(['./custom/shared/*']);
		// But missing ones are added
		expect(parsed.compilerOptions.paths['@modules/*']).toEqual(['./src/modules/*']);
	});

	test('aliases follow paths.* (PATH-0, #566)', () => {
		const layout = projectLayout('/p', {
			paths: { backend_src: 'apps/backend/src', generated: 'apps/backend/codegen' },
		});
		const parsed = JSON.parse(mergeTsconfig(JSON.stringify({ compilerOptions: {} }), layout).content);
		expect(parsed.compilerOptions.paths).toEqual({
			'@shared/*': ['./apps/backend/src/shared/*'],
			'@modules/*': ['./apps/backend/src/modules/*'],
			'@generated/*': ['./apps/backend/codegen/*'],
		});
	});

	test('tolerates JSONC comments', () => {
		const raw = `{
			// leading comment
			"compilerOptions": {
				/* inline block */
				"strict": true,
			}
		}`;
		const res = mergeTsconfig(raw, DEFAULT_LAYOUT);
		expect(res.unchanged).toBe(false);
		expect(res.added).toContain('@shared/*');
		const parsed = JSON.parse(res.content);
		expect(parsed.compilerOptions.strict).toBe(true);
	});

	test('adds decorator flags when missing', () => {
		const raw = JSON.stringify({ compilerOptions: {} });
		const res = mergeTsconfig(raw, DEFAULT_LAYOUT);
		const parsed = JSON.parse(res.content);
		expect(parsed.compilerOptions.experimentalDecorators).toBe(true);
		expect(parsed.compilerOptions.emitDecoratorMetadata).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// mergeFrontendDeps (ADR-038 FE-4)
// ---------------------------------------------------------------------------

describe('mergeFrontendDeps', () => {
	test('adds every version-pairing dep to a package.json with none', () => {
		const raw = JSON.stringify({ name: 'fe', dependencies: { react: '^19.0.0' } });
		const res = mergeFrontendDeps(raw);
		expect(res.unchanged).toBe(false);
		const deps = JSON.parse(res.content).dependencies;
		for (const [pkg, range] of Object.entries(FRONTEND_EMITTED_DEPS)) {
			expect(deps[pkg]).toBe(range);
		}
		// existing unrelated dep preserved
		expect(deps.react).toBe('^19.0.0');
	});

	// ── FE-0 review follow-up: the lockstep set is corrected, not preserved ──

	test('corrects pre-FE-0 caret ranges on the lockstep set, and says so', () => {
		// What `project init` wrote before FE-0 — the ranges that split the tree
		// into four @tanstack/db copies. Re-running init must not keep them.
		const raw = JSON.stringify({
			dependencies: {
				'@tanstack/db': '^0.5.11',
				'@tanstack/react-db': '^0.1.55',
				'@tanstack/electric-db-collection': '^0.2.11',
				'@tanstack/query-db-collection': '^1.0.6',
			},
		});
		const res = mergeFrontendDeps(raw);
		const deps = JSON.parse(res.content).dependencies;
		for (const [pkg, pin] of Object.entries(FRONTEND_LOCKSTEP_DEPS)) {
			expect(deps[pkg]).toBe(pin);
		}
		expect(res.corrected).toEqual([
			`@tanstack/db ^0.5.11 → ${FRONTEND_LOCKSTEP_DEPS['@tanstack/db']}`,
			`@tanstack/react-db ^0.1.55 → ${FRONTEND_LOCKSTEP_DEPS['@tanstack/react-db']}`,
			`@tanstack/electric-db-collection ^0.2.11 → ${FRONTEND_LOCKSTEP_DEPS['@tanstack/electric-db-collection']}`,
			`@tanstack/query-db-collection ^1.0.6 → ${FRONTEND_LOCKSTEP_DEPS['@tanstack/query-db-collection']}`,
		]);
		expect(res.added).not.toContain('@tanstack/db');
	});

	test('corrects one lockstep package moved without the other three', () => {
		const raw = JSON.stringify({
			dependencies: { ...FRONTEND_EMITTED_DEPS, '@tanstack/react-db': '0.1.80' },
			overrides: { ...FRONTEND_DEP_OVERRIDES },
		});
		const res = mergeFrontendDeps(raw);
		expect(res.unchanged).toBe(false);
		expect(res.added).toEqual([]);
		expect(res.corrected).toEqual([
			`@tanstack/react-db 0.1.80 → ${FRONTEND_LOCKSTEP_DEPS['@tanstack/react-db']}`,
		]);
		expect(mergeFrontendDeps(res.content).unchanged).toBe(true);
	});

	test('the lockstep set is exactly the four @tanstack/db-bearing packages', () => {
		expect(Object.keys(FRONTEND_LOCKSTEP_DEPS).sort()).toEqual([
			'@tanstack/db',
			'@tanstack/electric-db-collection',
			'@tanstack/query-db-collection',
			'@tanstack/react-db',
		]);
		for (const [pkg, pin] of Object.entries(FRONTEND_LOCKSTEP_DEPS)) {
			expect((FRONTEND_EMITTED_DEPS as Record<string, string>)[pkg]).toBe(pin);
		}
	});

	test('preserves an existing dep version — only adds missing keys', () => {
		const raw = JSON.stringify({
			dependencies: { '@tanstack/react-query': '^5.99.0' },
		});
		const res = mergeFrontendDeps(raw);
		const deps = JSON.parse(res.content).dependencies;
		// outside the lockstep set, the consumer's chosen range wins
		expect(deps['@tanstack/react-query']).toBe('^5.99.0');
		expect(res.added).not.toContain('@tanstack/react-query');
		expect(res.added).toContain('@pattern-stack/frontend-patterns');
	});

	test('is idempotent — re-merging the merged output reports unchanged', () => {
		const raw = JSON.stringify({ dependencies: {} });
		const once = mergeFrontendDeps(raw);
		const twice = mergeFrontendDeps(once.content);
		expect(twice.unchanged).toBe(true);
		expect(twice.added).toHaveLength(0);
	});

	test('returns parseError + unchanged on invalid JSON (never throws)', () => {
		const res = mergeFrontendDeps('{ not json');
		expect(res.parseError).toBeDefined();
		expect(res.unchanged).toBe(true);
	});

	// ── FE-0 (#620): the overrides half of the contract ──────────────────────

	test('adds the @tanstack/db override (belt-and-braces on the pins)', () => {
		const res = mergeFrontendDeps(JSON.stringify({ dependencies: {} }));
		const parsed = JSON.parse(res.content);
		for (const [pkg, spec] of Object.entries(FRONTEND_DEP_OVERRIDES)) {
			expect(parsed.overrides[pkg]).toBe(spec);
		}
		expect(res.added).toContain('overrides.@tanstack/db');
	});

	test('preserves an existing override — only adds missing keys', () => {
		const raw = JSON.stringify({
			dependencies: {},
			overrides: { '@tanstack/db': '0.5.11' },
		});
		const res = mergeFrontendDeps(raw);
		// the consumer's pin wins, exactly as it does for a dependency range
		expect(JSON.parse(res.content).overrides['@tanstack/db']).toBe('0.5.11');
		expect(res.added).not.toContain('overrides.@tanstack/db');
	});

	test('adds only the overrides when every dependency is already present', () => {
		const raw = JSON.stringify({ dependencies: { ...FRONTEND_EMITTED_DEPS } });
		const res = mergeFrontendDeps(raw);
		expect(res.unchanged).toBe(false);
		expect(res.added).toEqual(['overrides.@tanstack/db']);
	});

	test('the override target is a direct dependency, so `$name` resolves', () => {
		// `overrides: { X: '$X' }` means "resolve every copy of X to the version
		// the DIRECT dependency X declares". If X were not a direct dependency the
		// reference would not resolve and the four-copy tree would come back.
		for (const pkg of Object.keys(FRONTEND_DEP_OVERRIDES)) {
			const spec = (FRONTEND_DEP_OVERRIDES as Record<string, string>)[pkg];
			if (!spec?.startsWith('$')) continue;
			expect(Object.keys(FRONTEND_EMITTED_DEPS)).toContain(spec.slice(1));
		}
	});
});

// ---------------------------------------------------------------------------
// FE-0 (#620) — the version-pairing contract's own invariants
// ---------------------------------------------------------------------------

describe('FRONTEND_EMITTED_DEPS', () => {
	/**
	 * `@tanstack/react-db`, `@tanstack/electric-db-collection` and
	 * `@tanstack/query-db-collection` each declare `@tanstack/db` as an EXACT
	 * dependency and release in lockstep. A caret on any of them lets the tree
	 * split into several `@tanstack/db` copies — several type identities — and
	 * the emitted collections stop compiling (docs/specs/FE-0.md).
	 *
	 * `just test-smoke-frontend` proves the consequence against a real install;
	 * this fails in milliseconds and says why.
	 */
	const LOCKSTEP = [
		'@tanstack/db',
		'@tanstack/react-db',
		'@tanstack/electric-db-collection',
		'@tanstack/query-db-collection',
	] as const;

	test('every lockstep package is pinned exactly — no range prefix', () => {
		for (const pkg of LOCKSTEP) {
			const range = (FRONTEND_EMITTED_DEPS as Record<string, string>)[pkg];
			expect(range, `${pkg} is missing from the pairing`).toBeDefined();
			expect(range, `${pkg} must be an exact pin, got '${range}'`).toMatch(
				/^\d+\.\d+\.\d+$/,
			);
		}
	});

	test('declares @electric-sql/client, which the emitted collections import', () => {
		// `snakeCamelMapper`. It resolved only by hoisting before FE-0.
		expect(FRONTEND_EMITTED_DEPS).toHaveProperty('@electric-sql/client');
	});

	test('stays on the frontend-patterns alpha line — 1.0.0 ships no sync layer', () => {
		// The published 1.0.0 has no dist/sync (no createStore / createEntityHooks)
		// and is not dist-tagged `latest` — docs/specs/FE-REL.md §2.1.
		expect(FRONTEND_EMITTED_DEPS['@pattern-stack/frontend-patterns']).toContain('alpha');
	});
});

// ---------------------------------------------------------------------------
// init plan
// ---------------------------------------------------------------------------

describe('buildInitPlan', () => {
	test('vendored mode: plans codegen.config.yaml + shared shims + barrels for a fresh dir', async () => {
		const cwd = mkTempDir('plan');
		const ctx = await loadContext({ cwd, skipDetection: true });
		const plan = await buildInitPlan(ctx, { cwd, skipScan: true, runtimeMode: 'vendored' });
		const paths = plan.entries.map((e) => e.relPath);

		expect(paths).toContain('codegen.config.yaml');
		expect(paths).toContain('src/shared/database/database.module.ts');
		expect(paths).toContain('src/shared/constants/tokens.ts');
		expect(paths).toContain('src/shared/types/drizzle.ts');
		expect(paths).toContain('src/shared/base-classes/base-repository.ts');
		expect(paths).toContain('src/shared/base-classes/with-analytics.ts');
		expect(paths).toContain('src/shared/pipes/zod-validation.pipe.ts');
		expect(paths).toContain('src/generated/modules.ts');
		expect(paths).toContain('src/generated/schema.ts');
		expect(paths).toContain('src/app.module.ts');
		expect(paths).toContain('src/schema.ts');
		expect(paths).toContain('entities');
		expect(paths).toContain('entities/example.yaml');

		// No backend-architecture key: backend is the only pipeline (ARCH-0).
		const config = plan.entries.find((e) => e.relPath === 'codegen.config.yaml');
		expect(config?.content).not.toContain('architecture');
	});

	test('package mode (default): vendors NOTHING and writes runtime: package (ADR-037)', async () => {
		const cwd = mkTempDir('plan-package');
		const ctx = await loadContext({ cwd, skipDetection: true });
		// No runtimeMode → default `package`.
		const plan = await buildInitPlan(ctx, { cwd, skipScan: true });
		const paths = plan.entries.map((e) => e.relPath);

		// Config + app scaffold + the always-local database module still emit.
		expect(paths).toContain('codegen.config.yaml');
		expect(paths).toContain('src/shared/database/database.module.ts');
		expect(paths).toContain('src/generated/modules.ts');
		expect(paths).toContain('src/app.module.ts');
		// But NO vendored runtime closure under src/shared/{base-classes,types,…}.
		expect(paths).not.toContain('src/shared/base-classes/base-repository.ts');
		expect(paths).not.toContain('src/shared/constants/tokens.ts');
		expect(paths).not.toContain('src/shared/types/drizzle.ts');
		expect(paths).not.toContain('src/shared/pipes/zod-validation.pipe.ts');

		const config = plan.entries.find((e) => e.relPath === 'codegen.config.yaml');
		expect(config?.content).toContain('runtime: package');
	});

	test('vendored mode: writes runtime: vendored into the config (ADR-037)', async () => {
		const cwd = mkTempDir('plan-vendored-cfg');
		const ctx = await loadContext({ cwd, skipDetection: true });
		const plan = await buildInitPlan(ctx, { cwd, skipScan: true, runtimeMode: 'vendored' });
		const config = plan.entries.find((e) => e.relPath === 'codegen.config.yaml');
		expect(config?.content).toContain('runtime: vendored');
	});

	test('vendored mode: vendors the ambient-scope primitive (tenant-context) into base-classes', async () => {
		const cwd = mkTempDir('tenantctx');
		const ctx = await loadContext({ cwd, skipDetection: true });
		const plan = await buildInitPlan(ctx, { cwd, skipScan: true, runtimeMode: 'vendored' });
		const paths = plan.entries.map((e) => e.relPath);
		expect(paths).toContain('src/shared/base-classes/tenant-context.ts');
	});

	test('generated main.ts persists Swagger auth + carries the requester-context install hint', async () => {
		const cwd = mkTempDir('maints');
		const ctx = await loadContext({ cwd, skipDetection: true });
		const plan = await buildInitPlan(ctx, { cwd, skipScan: true });
		const mainTs = plan.entries.find((e) => e.relPath === 'src/main.ts');
		expect(mainTs?.content).toBeDefined();
		// Swagger "Authorize" token survives reloads → keeps flowing as a header.
		expect(mainTs!.content).toContain('persistAuthorization: true');
		// One-liner that turns that header into ambient tenant scope.
		expect(mainTs!.content).toContain('installRequesterContext(app)');
	});

	test('vendored mode: plans the ZodValidationPipe scaffold under src/shared/pipes (task #23)', async () => {
		const cwd = mkTempDir('zodpipe');
		const ctx = await loadContext({ cwd, skipDetection: true });
		const plan = await buildInitPlan(ctx, { cwd, skipScan: true, runtimeMode: 'vendored' });
		const paths = plan.entries.map((e) => e.relPath);
		expect(paths).toContain('src/shared/pipes/zod-validation.pipe.ts');
	});

	test('vendored mode: plans @shared/eav-helpers scaffold (task #23)', async () => {
		const cwd = mkTempDir('eavhelpers');
		const ctx = await loadContext({ cwd, skipDetection: true });
		const plan = await buildInitPlan(ctx, { cwd, skipScan: true, runtimeMode: 'vendored' });
		const paths = plan.entries.map((e) => e.relPath);
		expect(paths).toContain('src/shared/eav-helpers.ts');
	});

	test('skips existing files (idempotent)', async () => {
		const cwd = mkTempDir('idempotent');
		fs.writeFileSync(path.join(cwd, 'codegen.config.yaml'), '# existing\n');

		const ctx = await loadContext({ cwd, skipDetection: true });
		const plan = await buildInitPlan(ctx, { cwd, skipScan: true });
		const configEntry = plan.entries.find((e) => e.relPath === 'codegen.config.yaml');
		expect(configEntry?.action).toBe('skip');
		expect(configEntry?.reason).toContain('already exists');
	});

	test('--force flips skip to overwrite on existing files', async () => {
		const cwd = mkTempDir('force');
		fs.writeFileSync(path.join(cwd, 'codegen.config.yaml'), '# existing\n');

		const ctx = await loadContext({ cwd, skipDetection: true });
		const plan = await buildInitPlan(ctx, {
			cwd,
			force: true,
			skipScan: true,
		});
		const configEntry = plan.entries.find((e) => e.relPath === 'codegen.config.yaml');
		expect(configEntry?.action).toBe('overwrite');
	});

	test('without --with-tsconfig, skips missing tsconfig with a clear message', async () => {
		const cwd = mkTempDir('notsconfig');
		const ctx = await loadContext({ cwd, skipDetection: true });
		const plan = await buildInitPlan(ctx, { cwd, skipScan: true });
		const ts = plan.entries.find((e) => e.relPath === 'tsconfig.json');
		expect(ts?.action).toBe('skip');
		expect(ts?.reason).toContain('--with-tsconfig');
	});

	test('with --with-tsconfig, creates a new tsconfig if absent', async () => {
		const cwd = mkTempDir('withts');
		const ctx = await loadContext({ cwd, skipDetection: true });
		const plan = await buildInitPlan(ctx, {
			cwd,
			withTsconfig: true,
			skipScan: true,
		});
		const ts = plan.entries.find((e) => e.relPath === 'tsconfig.json');
		expect(ts?.action).toBe('create');
		expect(ts?.content).toContain('@shared/*');
	});

	test('merges aliases into an existing tsconfig', async () => {
		const cwd = mkTempDir('mergeTs');
		fs.writeFileSync(
			path.join(cwd, 'tsconfig.json'),
			JSON.stringify({ compilerOptions: { strict: true } })
		);
		const ctx = await loadContext({ cwd, skipDetection: true });
		const plan = await buildInitPlan(ctx, { cwd, skipScan: true });
		const ts = plan.entries.find((e) => e.relPath === 'tsconfig.json');
		expect(ts?.action).toBe('merge');
		expect(ts?.content).toContain('@shared/*');
	});

	// Frontend consumer deps (ADR-038 FE-4). The `frontend` gate is scanner-
	// detected (apps/frontend/ present → generate.frontend true), so these run
	// WITH scan enabled.
	test('frontend enabled + frontend package.json present → merge entry', async () => {
		const cwd = mkTempDir('fe-deps-merge');
		fs.mkdirSync(path.join(cwd, 'apps', 'frontend'), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, 'apps', 'frontend', 'package.json'),
			JSON.stringify({ name: 'frontend', dependencies: {} }),
		);
		const ctx = await loadContext({ cwd, skipDetection: true });
		const plan = await buildInitPlan(ctx, { cwd });
		expect(plan.summary.frontend).toBe(true);
		const pkg = plan.entries.find(
			(e) => e.relPath === 'apps/frontend/package.json',
		);
		expect(pkg?.action).toBe('merge');
		expect(pkg?.content).toContain('@pattern-stack/frontend-patterns');
	});

	test('frontend enabled + no frontend package.json → skip-notice listing deps', async () => {
		const cwd = mkTempDir('fe-deps-notice');
		// apps/frontend/ exists (so the scanner flips frontend on) but no
		// package.json inside it.
		fs.mkdirSync(path.join(cwd, 'apps', 'frontend'), { recursive: true });
		const ctx = await loadContext({ cwd, skipDetection: true });
		const plan = await buildInitPlan(ctx, { cwd });
		expect(plan.summary.frontend).toBe(true);
		const pkg = plan.entries.find(
			(e) => e.relPath === 'apps/frontend/package.json',
		);
		expect(pkg?.action).toBe('skip');
		expect(pkg?.reason).toContain('@pattern-stack/frontend-patterns');
	});

	test('frontend DISABLED (default) → no frontend package.json entry', async () => {
		const cwd = mkTempDir('fe-deps-off');
		const ctx = await loadContext({ cwd, skipDetection: true });
		const plan = await buildInitPlan(ctx, { cwd, skipScan: true });
		expect(plan.summary.frontend).toBe(false);
		const pkg = plan.entries.find((e) =>
			e.relPath.endsWith('apps/frontend/package.json'),
		);
		expect(pkg).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// writePlan — integration with the filesystem
// ---------------------------------------------------------------------------

describe('writePlan', () => {
	test('creates all planned files under the cwd', async () => {
		const cwd = mkTempDir('write');
		const ctx = await loadContext({ cwd, skipDetection: true });
		const plan = await buildInitPlan(ctx, {
			cwd,
			withTsconfig: true,
			skipScan: true,
			runtimeMode: 'vendored',
		});
		const result = writePlan(plan);

		// Every scaffolded file should exist
		expect(fs.existsSync(path.join(cwd, 'codegen.config.yaml'))).toBe(true);
		expect(fs.existsSync(path.join(cwd, 'src/shared/database/database.module.ts'))).toBe(true);
		expect(fs.existsSync(path.join(cwd, 'src/shared/constants/tokens.ts'))).toBe(true);
		expect(fs.existsSync(path.join(cwd, 'src/generated/modules.ts'))).toBe(true);
		expect(fs.existsSync(path.join(cwd, 'src/app.module.ts'))).toBe(true);
		expect(fs.existsSync(path.join(cwd, 'src/schema.ts'))).toBe(true);
		expect(fs.existsSync(path.join(cwd, 'entities/example.yaml'))).toBe(true);

		expect(result.created.length).toBeGreaterThan(10);
		expect(result.skipped.length).toBe(0);
	});

	test('second writePlan call is a no-op (idempotent)', async () => {
		const cwd = mkTempDir('write2x');

		const ctx1 = await loadContext({ cwd, skipDetection: true });
		const plan1 = await buildInitPlan(ctx1, {
			cwd,
			withTsconfig: true,
			skipScan: true,
			runtimeMode: 'vendored',
		});
		writePlan(plan1);

		const ctx2 = await loadContext({ cwd, skipDetection: true });
		const plan2 = await buildInitPlan(ctx2, {
			cwd,
			withTsconfig: true,
			skipScan: true,
			runtimeMode: 'vendored',
		});
		const result2 = writePlan(plan2);

		// Second invocation should skip every file.
		expect(result2.created.length).toBe(0);
		expect(result2.skipped.length).toBeGreaterThan(10);
	});
});
