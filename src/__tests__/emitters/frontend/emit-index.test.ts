/**
 * Frontend emitter — root barrel + whole-set tests (ADR-038, FE-3).
 *
 * Covers the version-pairing comment, the section-commented re-exports, the
 * whole-set file inventory (matches the parent spec's target tree), and
 * byte-identical re-emission of the entire `emitFrontendSet`.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { Glob } from 'bun';
import {
	buildRootIndexFile,
	buildVersionPairingComment,
} from '../../../emitters/frontend/emit-index';
import { emitFrontendSet } from '../../../emitters/frontend';
import { FRONTEND_EMITTED_DEPS } from '../../../emitters/frontend/deps';
import {
	ctx,
	entry,
	field,
	parsedEntity,
	parsedMap,
	relationship,
} from './_helpers';

describe('emit-index — version pairing comment', () => {
	it('lists every emitted dep + range', () => {
		const out = buildVersionPairingComment();
		for (const [name, range] of Object.entries(FRONTEND_EMITTED_DEPS)) {
			expect(out).toContain(name);
			expect(out).toContain(range);
		}
		expect(out).toContain('@pattern-stack/frontend-patterns');
	});
});

describe('emit-index — root barrel', () => {
	it('re-exports each sub-barrel + store module-index with the deps comment', () => {
		const c = ctx([entry('contact', 'contacts')]);
		const out = buildRootIndexFile(c);
		expect(out).toContain("export * from './config';");
		expect(out).toContain("export * from './query-client';");
		expect(out).toContain("export * from './api/index';");
		expect(out).toContain("export * from './collections/index';");
		expect(out).toContain("export * from './entities/index';");
		expect(out).toContain("export * from './fields/index';");
		expect(out).toContain("export * from './store/module-index';");
		expect(out).toContain('Version pairing');
		expect(out).toContain(' * - Contact');
	});
});

/** Two-entity ctx: person (people) ← task.assignee_id, task has timestamps. */
function twoEntityCtx() {
	const person = entry('person', 'people');
	const task = entry('task', 'tasks');
	const parsed = parsedMap(
		parsedEntity(person, {
			fields: new Map([['name', field('name', { required: true })]]),
		}),
		parsedEntity(task, {
			behaviors: ['timestamps'],
			fields: new Map([
				['title', field('title', { required: true })],
				['assignee_id', field('assignee_id', { foreignKey: { table: 'people', column: 'id' } })],
			]),
			relationships: new Map([
				['assignee', relationship('assignee', { target: 'person', foreignKey: 'assignee_id' })],
			]),
		}),
	);
	return ctx([person, task], {}, parsed);
}

describe('emit-index — whole-set emission', () => {
	it('writes the full target tree into outDir', () => {
		const dir = mkdtempSync(join(tmpdir(), 'fe3-'));
		try {
			emitFrontendSet(twoEntityCtx(), dir);
			const found = new Set(
				Array.from(new Glob('**/*.ts').scanSync({ cwd: dir })).map((p) =>
					p.replace(/\\/g, '/'),
				),
			);

			const expected = [
				'query-client.ts',
				'config.ts',
				'index.ts',
				'api/client.ts',
				'api/person.ts',
				'api/task.ts',
				'api/index.ts',
				'collections/person.ts',
				'collections/task.ts',
				'collections/index.ts',
				'entities/person.ts',
				'entities/task.ts',
				'entities/index.ts',
				'store/index.ts',
				'store/resolvers.ts',
				'store/lookups.ts',
				'store/module-index.ts',
				'fields/field-meta.ts',
				'fields/person.ts',
				'fields/task.ts',
				'fields/index.ts',
			];
			for (const f of expected) {
				expect(found.has(f)).toBe(true);
			}
			expect(found.size).toBe(expected.length);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('returns written paths and produces byte-identical re-emission', () => {
		const dirA = mkdtempSync(join(tmpdir(), 'fe3a-'));
		const dirB = mkdtempSync(join(tmpdir(), 'fe3b-'));
		try {
			const pathsA = emitFrontendSet(twoEntityCtx(), dirA);
			const pathsB = emitFrontendSet(twoEntityCtx(), dirB);

			const relA = pathsA.map((p) => relative(dirA, p)).sort();
			const relB = pathsB.map((p) => relative(dirB, p)).sort();
			expect(relA).toEqual(relB);

			for (const rel of relA) {
				const a = readFileSync(join(dirA, rel), 'utf8');
				const b = readFileSync(join(dirB, rel), 'utf8');
				expect(a).toBe(b);
			}
		} finally {
			rmSync(dirA, { recursive: true, force: true });
			rmSync(dirB, { recursive: true, force: true });
		}
	});
});
