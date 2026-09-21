/**
 * `GET /api/diff` (STUDIO-0, #698).
 *
 * The patch text goes straight into a pane in the browser, so what it contains
 * matters beyond "is it a diff": an untracked file used to be passed to `git
 * diff --no-index` as an ABSOLUTE path, which put the host's directory layout
 * into every such patch header.
 */
import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getDiff, isGitRepo, parsePorcelainZ, statusFromPorcelain } from '../../studio/server/diff';

const roots: string[] = [];
let projectDir: string;

function git(args: string[], cwd: string): void {
	const res = spawnSync('git', args, { cwd, encoding: 'utf-8' });
	if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
}

beforeEach(() => {
	projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-diff-'));
	roots.push(projectDir);
	git(['init', '-q'], projectDir);
	git(['config', 'user.email', 'test@example.invalid'], projectDir);
	git(['config', 'user.name', 'test'], projectDir);
	fs.writeFileSync(path.join(projectDir, 'tracked.txt'), 'one\n');
	git(['add', '-A'], projectDir);
	git(['commit', '-q', '-m', 'baseline'], projectDir);
});

afterAll(() => {
	for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe('getDiff', () => {
	it('returns nothing for a clean tree', () => {
		expect(getDiff(projectDir).files).toEqual([]);
	});

	it('reports a modified file with a patch', () => {
		fs.writeFileSync(path.join(projectDir, 'tracked.txt'), 'two\n');
		const [file] = getDiff(projectDir).files;
		expect(file.path).toBe('tracked.txt');
		expect(file.status).toBe('modified');
		expect(file.patch).toContain('+two');
	});

	it('lists each file under an untracked DIRECTORY, not the collapsed directory', () => {
		// Plain `--porcelain` emits one `?? src/modules/` entry, which is
		// exactly the case the demo is about: a newly generated module folder.
		// Named as the generator actually names it (kebab-case module folders,
		// #695) so the fixture stays an honest picture of the real case.
		const dir = path.join(projectDir, 'src', 'modules', 'contact-opportunities');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
		fs.writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2;\n');

		const paths = getDiff(projectDir).files.map((f) => f.path);
		expect(paths).toContain('src/modules/contact-opportunities/a.ts');
		expect(paths).toContain('src/modules/contact-opportunities/b.ts');
		expect(paths).not.toContain('src/modules/');
	});

	it('gives an untracked file an all-added patch — `git diff` alone emits none', () => {
		fs.writeFileSync(path.join(projectDir, 'fresh.ts'), 'export const x = 1;\n');
		const [file] = getDiff(projectDir).files;
		expect(file.status).toBe('untracked');
		expect(file.patch).toContain('+export const x = 1;');
	});

	it('does NOT leak the absolute host path into an untracked patch', () => {
		// The patch is rendered in the browser; the host's directory layout is
		// not the project's business and must not travel with it.
		fs.writeFileSync(path.join(projectDir, 'fresh.ts'), 'export const x = 1;\n');
		const [file] = getDiff(projectDir).files;
		expect(file.patch).not.toContain(projectDir);
		expect(file.patch).not.toContain(os.tmpdir());
		expect(file.patch).toContain('+++ b/fresh.ts');
	});

	it('handles a path containing a space', () => {
		fs.writeFileSync(path.join(projectDir, 'two words.txt'), 'hi\n');
		expect(getDiff(projectDir).files.map((f) => f.path)).toContain('two words.txt');
	});

	it('returns empty rather than throwing outside a git repo', () => {
		const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-nogit-'));
		roots.push(plain);
		expect(isGitRepo(plain)).toBe(false);
		expect(getDiff(plain).files).toEqual([]);
	});
});

describe('porcelain parsing', () => {
	it('maps the XY codes to wire statuses', () => {
		expect(statusFromPorcelain('??')).toBe('untracked');
		expect(statusFromPorcelain(' M')).toBe('modified');
		expect(statusFromPorcelain('A ')).toBe('added');
		expect(statusFromPorcelain(' D')).toBe('deleted');
		expect(statusFromPorcelain('R ')).toBe('renamed');
	});

	it('consumes the source path of a rename rather than listing it as a file', () => {
		// A rename is two NUL-terminated records: new path, then old path.
		const out = 'R  new.txt\0old.txt\0 M other.txt\0';
		expect(parsePorcelainZ(out)).toEqual([
			{ code: 'R ', file: 'new.txt' },
			{ code: ' M', file: 'other.txt' },
		]);
	});

	it('needs no unquoting for a path with a space or a quote', () => {
		const out = '?? two words.txt\0?? say "hi".txt\0';
		expect(parsePorcelainZ(out).map((e) => e.file)).toEqual(['two words.txt', 'say "hi".txt']);
	});
});
