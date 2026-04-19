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
} from '../../cli/shared/init-scaffold.js';
import { loadContext } from '../../cli/shared/context.js';

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
	test('exports name=project with all five commands', () => {
		expect(projectNoun.name).toBe('project');
		expect(projectNoun.commandClasses.length).toBe(5);
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
			'generate:\n  architecture: clean-lite-ps\n'
		);
		const ctx = await loadContext({ cwd, skipDetection: true });
		const pane = await projectNoun.summary(ctx);
		const body = (pane.body as string[]).join('\n');
		expect(body).toContain('initialized');
		expect(body).toContain('clean-lite-ps');
	});
});

// ---------------------------------------------------------------------------
// tsconfig merge
// ---------------------------------------------------------------------------

describe('mergeTsconfig', () => {
	test('adds missing aliases to a minimal tsconfig', () => {
		const raw = JSON.stringify({ compilerOptions: {} });
		const res = mergeTsconfig(raw);
		expect(res.unchanged).toBe(false);
		expect(res.added).toContain('@shared/*');
		expect(res.added).toContain('@modules/*');
		expect(res.added).toContain('@generated/*');
		const parsed = JSON.parse(res.content);
		expect(parsed.compilerOptions.paths['@shared/*']).toEqual(['./src/shared/*']);
	});

	test('is idempotent — second merge reports unchanged', () => {
		const raw = JSON.stringify({ compilerOptions: {} });
		const once = mergeTsconfig(raw);
		const twice = mergeTsconfig(once.content);
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
		const res = mergeTsconfig(raw);
		const parsed = JSON.parse(res.content);
		// User's custom target is preserved
		expect(parsed.compilerOptions.paths['@shared/*']).toEqual(['./custom/shared/*']);
		// But missing ones are added
		expect(parsed.compilerOptions.paths['@modules/*']).toEqual(['./src/modules/*']);
	});

	test('tolerates JSONC comments', () => {
		const raw = `{
			// leading comment
			"compilerOptions": {
				/* inline block */
				"strict": true,
			}
		}`;
		const res = mergeTsconfig(raw);
		expect(res.unchanged).toBe(false);
		expect(res.added).toContain('@shared/*');
		const parsed = JSON.parse(res.content);
		expect(parsed.compilerOptions.strict).toBe(true);
	});

	test('adds decorator flags when missing', () => {
		const raw = JSON.stringify({ compilerOptions: {} });
		const res = mergeTsconfig(raw);
		const parsed = JSON.parse(res.content);
		expect(parsed.compilerOptions.experimentalDecorators).toBe(true);
		expect(parsed.compilerOptions.emitDecoratorMetadata).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// init plan
// ---------------------------------------------------------------------------

describe('buildInitPlan', () => {
	test('plans codegen.config.yaml + shared shims + barrels for a fresh dir', async () => {
		const cwd = mkTempDir('plan');
		const ctx = await loadContext({ cwd, skipDetection: true });
		const plan = await buildInitPlan(ctx, { cwd, skipScan: true });
		const paths = plan.entries.map((e) => e.relPath);

		expect(paths).toContain('codegen.config.yaml');
		expect(paths).toContain('src/shared/database/database.module.ts');
		expect(paths).toContain('src/shared/constants/tokens.ts');
		expect(paths).toContain('src/shared/types/drizzle.ts');
		expect(paths).toContain('src/shared/base-classes/base-repository.ts');
		expect(paths).toContain('src/shared/base-classes/with-analytics.ts');
		expect(paths).toContain('src/generated/modules.ts');
		expect(paths).toContain('src/generated/schema.ts');
		expect(paths).toContain('src/app.module.ts');
		expect(paths).toContain('src/schema.ts');
		expect(paths).toContain('entities');
		expect(paths).toContain('entities/example.yaml');

		// Defaults to clean-lite-ps (matches the demo app + CONSUMER-SETUP).
		expect(plan.summary.architecture).toBe('clean-lite-ps');
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
		});
		writePlan(plan1);

		const ctx2 = await loadContext({ cwd, skipDetection: true });
		const plan2 = await buildInitPlan(ctx2, {
			cwd,
			withTsconfig: true,
			skipScan: true,
		});
		const result2 = writePlan(plan2);

		// Second invocation should skip every file.
		expect(result2.created.length).toBe(0);
		expect(result2.skipped.length).toBeGreaterThan(10);
	});
});
