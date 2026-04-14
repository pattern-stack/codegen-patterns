/**
 * Tests for loadContext() — walks upward for codegen.config.yaml, detects
 * entity count, and reports whether the project is initialized.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadContext } from '../../cli/shared/context.js';

function mkTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `ctx-${prefix}-`));
}

let tempRoots: string[] = [];

function makeProject(layout: Record<string, string>): string {
	const root = mkTempDir('proj');
	tempRoots.push(root);
	for (const [rel, content] of Object.entries(layout)) {
		const full = path.join(root, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
	}
	return root;
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

describe('loadContext', () => {
	test('returns uninitialized context when no config and no entities', async () => {
		const root = makeProject({});
		const ctx = await loadContext({ cwd: root, skipDetection: true });
		expect(ctx.cwd).toBe(path.resolve(root));
		expect(ctx.configPath).toBeNull();
		expect(ctx.isInitialized).toBe(false);
		expect(ctx.entityCount).toBe(0);
	});

	test('detects config at cwd root', async () => {
		const root = makeProject({
			'codegen.config.yaml': 'paths:\n  entities: entities\n',
			'entities/one.yaml': 'entity:\n  name: one\n',
			'entities/two.yaml': 'entity:\n  name: two\n',
		});
		const ctx = await loadContext({ cwd: root, skipDetection: true });
		expect(ctx.configPath).toBe(path.join(path.resolve(root), 'codegen.config.yaml'));
		expect(ctx.isInitialized).toBe(true);
		expect(ctx.entityCount).toBe(2);
		expect(ctx.entitiesDir).toContain('entities');
	});

	test('walks upward to find config', async () => {
		const root = makeProject({
			'codegen.config.yaml': 'paths:\n  entities: entities\n',
			'apps/web/placeholder.txt': '-',
		});
		const nested = path.join(root, 'apps', 'web');
		const ctx = await loadContext({ cwd: nested, skipDetection: true });
		expect(ctx.configPath).toBe(path.join(path.resolve(root), 'codegen.config.yaml'));
		expect(ctx.isInitialized).toBe(true);
	});

	test('counts only .yaml/.yml files in entities dir', async () => {
		const root = makeProject({
			'codegen.config.yaml': 'paths:\n  entities: entities\n',
			'entities/a.yaml': 'x: 1\n',
			'entities/b.yml': 'x: 1\n',
			'entities/notes.md': '# notes',
		});
		const ctx = await loadContext({ cwd: root, skipDetection: true });
		expect(ctx.entityCount).toBe(2);
	});

	test('respects explicit --config override when file exists', async () => {
		const root = makeProject({
			'alt.yaml': 'paths:\n  entities: entities\n',
			'entities/a.yaml': 'x: 1\n',
		});
		const ctx = await loadContext({
			cwd: root,
			configPath: path.join(root, 'alt.yaml'),
			skipDetection: true,
		});
		expect(ctx.configPath).toBe(path.join(path.resolve(root), 'alt.yaml'));
	});
});
