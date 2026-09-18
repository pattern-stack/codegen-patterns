/**
 * The one entities-directory rule (NAME-0) — read by the CLI context and, via
 * `templates/_shared/entity-naming.mjs`, by the hygen prompts.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	entitiesDirPath,
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

describe('entitiesDirPath', () => {
	it('the resolved paths.entities, against cwd — one value, no second candidate (PATH-0)', () => {
		expect(entitiesDirPath('/p', { entities: 'a' })).toBe('/p/a');
		expect(entitiesDirPath('/p', { entities: 'entities' })).toBe('/p/entities');
	});
});

describe('resolveEntitiesDir', () => {
	it('the configured directory when it exists', () => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, 'defs'));
		fs.mkdirSync(path.join(cwd, 'entities'));
		expect(resolveEntitiesDir(cwd, { entities: 'defs' })).toBe(path.join(cwd, 'defs'));
	});

	it('a stale configured path is null — no fallback to <cwd>/entities (PATH-0)', () => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, 'entities'));
		expect(resolveEntitiesDir(cwd, { entities: 'gone' })).toBeNull();
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
