/**
 * The one entities-directory rule (NAME-0) — read by the CLI context and, via
 * `templates/_shared/entity-naming.mjs`, by the hygen prompts.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	entitiesDirCandidates,
	findConfigUpward,
	resolveEntitiesDir,
} from '../../config/entities-dir';

const tmpDirs: string[] = [];
function tmp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entities-dir-'));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('entitiesDirCandidates', () => {
	it('configured first (paths.entities over paths.entities_dir), then <cwd>/entities', () => {
		expect(entitiesDirCandidates('/p', { entities: 'a', entities_dir: 'b' })).toEqual(['/p/a', '/p/entities']);
		expect(entitiesDirCandidates('/p', { entities_dir: 'b' })).toEqual(['/p/b', '/p/entities']);
		expect(entitiesDirCandidates('/p', null)).toEqual(['/p/entities']);
		expect(entitiesDirCandidates('/p', { entities: 'entities' })).toEqual(['/p/entities']);
	});
});

describe('resolveEntitiesDir', () => {
	it('the first candidate that exists as a directory', () => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, 'defs'));
		fs.mkdirSync(path.join(cwd, 'entities'));
		expect(resolveEntitiesDir(cwd, { entities: 'defs' })).toBe(path.join(cwd, 'defs'));
	});

	it('a stale configured path falls back to <cwd>/entities', () => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, 'entities'));
		expect(resolveEntitiesDir(cwd, { entities: 'gone' })).toBe(path.join(cwd, 'entities'));
	});

	it('null when nothing exists', () => {
		expect(resolveEntitiesDir(tmp(), { entities: 'gone' })).toBeNull();
	});
});

describe('findConfigUpward', () => {
	it('walks up to the nearest codegen.config.yaml', () => {
		const root = tmp();
		fs.writeFileSync(path.join(root, 'codegen.config.yaml'), '');
		const deep = path.join(root, 'a', 'b');
		fs.mkdirSync(deep, { recursive: true });
		expect(findConfigUpward(deep)).toBe(path.join(root, 'codegen.config.yaml'));
	});
});
