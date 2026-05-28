/**
 * findYamlFiles unit tests.
 *
 * The motivating case is domain-folder discovery: codegen used to read only the
 * top level of the definitions directory, so `entities/<domain>/*.yaml` layouts
 * were silently skipped ("0 checked / No YAML files found"). findYamlFiles walks
 * the full tree, so every discovery site picks up nested domain folders.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findYamlFiles } from '../../utils/find-yaml-files';

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'find-yaml-'));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function touch(rel: string): string {
	const full = join(dir, rel);
	mkdirSync(join(full, '..'), { recursive: true });
	writeFileSync(full, '# fixture\n');
	return resolve(full);
}

describe('findYamlFiles', () => {
	it('finds flat top-level YAML files', () => {
		const a = touch('account.yaml');
		const b = touch('contact.yml');
		expect(findYamlFiles(dir)).toEqual([a, b].sort());
	});

	it('recurses into domain folders (the bug this fixes)', () => {
		const flat = touch('audit.yaml');
		const crm = touch('crm/account.yaml');
		const billing = touch('billing/invoice.yml');
		expect(findYamlFiles(dir)).toEqual([flat, crm, billing].sort());
	});

	it('recurses arbitrarily deep', () => {
		const deep = touch('a/b/c/deep.yaml');
		expect(findYamlFiles(dir)).toEqual([deep]);
	});

	it('ignores non-YAML files', () => {
		const yaml = touch('keep.yaml');
		touch('README.md');
		touch('notes.txt');
		expect(findYamlFiles(dir)).toEqual([yaml]);
	});

	it('skips dot-directories so .git / tooling folders are never mistaken for domains', () => {
		const real = touch('crm/account.yaml');
		touch('.git/config.yaml');
		touch('.cache/stale.yml');
		expect(findYamlFiles(dir)).toEqual([real]);
	});

	it('returns absolute paths sorted lexicographically (deterministic generation order)', () => {
		touch('z/last.yaml');
		touch('a/first.yaml');
		touch('m/middle.yaml');
		const result = findYamlFiles(dir);
		expect(result).toEqual([...result].sort());
		for (const p of result) expect(p.startsWith('/')).toBe(true);
	});

	it('returns an empty array for a present-but-empty directory', () => {
		expect(findYamlFiles(dir)).toEqual([]);
	});

	it('throws for a missing directory (callers guard with existsSync / try-catch)', () => {
		expect(() => findYamlFiles(join(dir, 'does-not-exist'))).toThrow();
	});
});
