/**
 * Unit tests for the shared tree-copier (copyTreeWithReport) — the drift-aware
 * recursive copy that backs `skills install` and `codegen update`.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { copyTreeWithReport } from '../../cli/shared/tree-copier.js';

const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

function seedSource(): string {
	const src = mkTemp('tree-src-');
	fs.mkdirSync(path.join(src, 'a'), { recursive: true });
	fs.writeFileSync(path.join(src, 'top.md'), 'top\n');
	fs.writeFileSync(path.join(src, 'a', 'nested.md'), 'nested\n');
	return src;
}

describe('copyTreeWithReport', () => {
	test('created: empty target → every file written + classified created', () => {
		const src = seedSource();
		const dest = mkTemp('tree-dst-');
		const report = copyTreeWithReport({ srcDir: src, destDir: dest });
		expect(report.created.length).toBe(2);
		expect(report.updated.length).toBe(0);
		expect(report.unchanged.length).toBe(0);
		expect(fs.readFileSync(path.join(dest, 'a', 'nested.md'), 'utf-8')).toBe('nested\n');
	});

	test('unchanged: identical re-run writes nothing new', () => {
		const src = seedSource();
		const dest = mkTemp('tree-dst-');
		copyTreeWithReport({ srcDir: src, destDir: dest });
		const second = copyTreeWithReport({ srcDir: src, destDir: dest });
		expect(second.created.length).toBe(0);
		expect(second.updated.length).toBe(0);
		expect(second.unchanged.length).toBe(2);
	});

	test('updated: divergent target file is overwritten', () => {
		const src = seedSource();
		const dest = mkTemp('tree-dst-');
		copyTreeWithReport({ srcDir: src, destDir: dest });
		fs.writeFileSync(path.join(dest, 'top.md'), 'LOCAL EDIT\n');
		const report = copyTreeWithReport({ srcDir: src, destDir: dest });
		expect(report.updated.map((e) => e.relPath)).toContain('top.md');
		expect(fs.readFileSync(path.join(dest, 'top.md'), 'utf-8')).toBe('top\n');
	});

	test('dry-run classifies without writing', () => {
		const src = seedSource();
		const dest = mkTemp('tree-dst-');
		const report = copyTreeWithReport({ srcDir: src, destDir: dest, dryRun: true });
		expect(report.created.length).toBe(2);
		expect(fs.existsSync(path.join(dest, 'top.md'))).toBe(false);
	});

	test('include filter excludes matching files', () => {
		const src = seedSource();
		const dest = mkTemp('tree-dst-');
		const report = copyTreeWithReport({
			srcDir: src,
			destDir: dest,
			include: (rel) => !rel.startsWith('a/'),
		});
		expect(report.created.map((e) => e.relPath)).toEqual(['top.md']);
		expect(fs.existsSync(path.join(dest, 'a', 'nested.md'))).toBe(false);
	});
});
