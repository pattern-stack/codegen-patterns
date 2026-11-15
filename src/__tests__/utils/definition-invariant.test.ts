/**
 * #915 — every loader a whole-set step reads through throws on an invalid
 * definition instead of skipping it. One test per loader family; each is called
 * directly, past the pre-flight, with one valid and one invalid file.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectEntityEvents, collectMergedEvents } from '../../cli/shared/event-codegen-generator.js';
import { collectScopeableNames } from '../../cli/shared/scope-entity-type-generator.js';
import { regenerateBarrels } from '../../cli/shared/barrel-generator.js';
import {
	loadEntityDefinitions,
	loadJunctionDefinitions,
	loadRelationsEmitContext,
} from '../../emitters/relations/load-context.js';
import { loadSemanticEmitContext } from '../../emitters/semantic/load-context.js';
import { loadFrontendEmitContext } from '../../emitters/frontend/load-context.js';
import { loadEntityRegistry } from '../../parser/entity-registry.js';
import { assertNoInvalidDefinitions, InvalidDefinitionError } from '../../utils/definition-invariant.js';

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

const NOTE = 'entity:\n  name: note\n  plural: notes\nfields:\n  body:\n    type: string\n';
const BAD_ENTITY = 'entity:\n  name: bad\n  plural: bads\nconfig:\n  x: 1\n';

function mkRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invariant-'));
	dirs.push(root);
	fs.mkdirSync(path.join(root, 'entities'));
	fs.writeFileSync(path.join(root, 'entities', 'note.yaml'), NOTE);
	return root;
}

function withBadEntity(): string {
	const root = mkRoot();
	fs.writeFileSync(path.join(root, 'entities', 'bad.yaml'), BAD_ENTITY);
	return root;
}

function withBadJunction(): string {
	const root = mkRoot();
	fs.mkdirSync(path.join(root, 'junctions'));
	fs.writeFileSync(path.join(root, 'junctions', 'broken.yaml'), 'pattern: Junction\nbetween: [note]\n');
	return root;
}

/** The throw names the file and carries the invariant message. */
function expectInvariant(fn: () => unknown, file: string): void {
	let caught: unknown;
	try {
		fn();
	} catch (err) {
		caught = err;
	}
	expect(caught).toBeInstanceOf(InvalidDefinitionError);
	const message = (caught as Error).message;
	expect(message).toContain(file);
	expect(message).toContain('the pre-flight should have stopped it');
}

describe('whole-set loaders throw on an invalid definition (#915)', () => {
	test('event codegen: collectEntityEvents / collectMergedEvents', () => {
		const root = withBadEntity();
		const entitiesDir = path.join(root, 'entities');
		expectInvariant(() => collectEntityEvents(entitiesDir), 'bad.yaml');
		expectInvariant(() => collectMergedEvents({ entitiesDir, eventsDir: path.join(root, 'events') }), 'bad.yaml');
		// The pre-flight's explicit opt-in still skips.
		expect(() => collectMergedEvents({ entitiesDir, eventsDir: path.join(root, 'events'), skipInvalid: true })).not.toThrow();
	});

	test('scope union: collectScopeableNames', () => {
		const root = withBadEntity();
		expectInvariant(() => collectScopeableNames(path.join(root, 'entities')), 'bad.yaml');
	});

	test('barrels: an entity, a junction and a relationship each throw, naming its own file', async () => {
		const ctx = { cwd: '/', config: null } as never;
		const cases: Array<[string, () => string]> = [
			['bad.yaml', withBadEntity],
			['broken.yaml', withBadJunction],
			[
				'broken_rel.yaml',
				() => {
					const root = mkRoot();
					fs.mkdirSync(path.join(root, 'relationships'));
					fs.writeFileSync(path.join(root, 'relationships', 'broken_rel.yaml'), 'relationship:\n  name: broken_rel\n  from: note\n');
					return root;
				},
			],
		];
		for (const [file, make] of cases) {
			const root = make();
			let caught: unknown;
			try {
				await regenerateBarrels({
					ctx,
					entitiesDir: path.join(root, 'entities'),
					relationshipsDir: path.join(root, 'relationships'),
					junctionsDir: path.join(root, 'junctions'),
					generatedDir: path.join(root, 'generated'),
					dryRun: true,
				});
			} catch (err) {
				caught = err;
			}
			// `generating` wraps it in a GeneratedFileError naming the barrel; the cause
			// is still the invariant breach, named file and all.
			const message = (caught as Error).message;
			expect(message).toContain('the pre-flight should have stopped it');
			expect(message).toContain(file);
			// `broken.yaml` must not satisfy `broken_rel.yaml` or the reverse.
			for (const other of cases.map(([f]) => f).filter((f) => f !== file)) expect(message).not.toContain(other);
		}
	});

	test('the directory exemption is a directory that does not exist, nothing else', () => {
		const missing = path.join(mkRoot(), 'no-such-dir');
		const read = (dir: string) => loadEntityRegistry(dir, { tablePrefix: '' }).issues;
		// Absent: an empty set, not an invalid definition.
		expect(() => assertNoInvalidDefinitions(read(missing))).not.toThrow();
		// Present but not a directory (ENOTDIR): the read fails and the invariant says so.
		const notADir = path.join(mkRoot(), 'entities-file');
		fs.writeFileSync(notADir, 'x');
		expect(() => assertNoInvalidDefinitions(read(notADir))).toThrow('cannot be read');
		// Present but unreadable (EACCES).
		const locked = path.join(mkRoot(), 'locked');
		fs.mkdirSync(locked);
		fs.chmodSync(locked, 0o000);
		try {
			if (process.getuid?.() !== 0) expect(() => assertNoInvalidDefinitions(read(locked))).toThrow('cannot be read');
		} finally {
			fs.chmodSync(locked, 0o755);
		}
	});

	test('a provider / jobs directory under the entities root is not read as entities', () => {
		const root = mkRoot();
		fs.mkdirSync(path.join(root, 'entities', 'providers'));
		fs.writeFileSync(path.join(root, 'entities', 'providers', 'p.yaml'), 'slug: p\n');
		const nonEntityDirs = [path.join(root, 'entities', 'providers')];
		expect(collectScopeableNames(path.join(root, 'entities'), nonEntityDirs)).toEqual([]);
		expect(() => collectScopeableNames(path.join(root, 'entities'))).toThrow('p.yaml');
		expect(loadEntityDefinitions(path.join(root, 'entities'), nonEntityDirs).size).toBe(1);
		expect(collectEntityEvents(path.join(root, 'entities'), { nonEntityDirs }).events).toEqual([]);
	});

	test('relations manifest: loadEntityDefinitions / loadJunctionDefinitions / loadRelationsEmitContext', () => {
		const bad = withBadEntity();
		expectInvariant(() => loadEntityDefinitions(path.join(bad, 'entities')), 'bad.yaml');
		expectInvariant(() => loadRelationsEmitContext(bad, null, { entitiesDir: path.join(bad, 'entities') }), 'bad.yaml');
		const junction = withBadJunction();
		expectInvariant(() => loadJunctionDefinitions(path.join(junction, 'junctions')), 'broken.yaml');
	});

	test('semantic model: loadSemanticEmitContext', () => {
		const root = withBadEntity();
		expectInvariant(() => loadSemanticEmitContext(root, null, { entitiesDir: path.join(root, 'entities') }), 'bad.yaml');
		const junction = withBadJunction();
		expectInvariant(
			() => loadSemanticEmitContext(junction, null, { entitiesDir: path.join(junction, 'entities'), junctionsDir: path.join(junction, 'junctions') }),
			'broken.yaml',
		);
	});

	test('frontend: loadFrontendEmitContext', () => {
		const root = withBadEntity();
		expectInvariant(() => loadFrontendEmitContext(root, {}, { entitiesDir: path.join(root, 'entities') }), 'bad.yaml');
	});
});
