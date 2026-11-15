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
import { InvalidDefinitionError } from '../../utils/definition-invariant.js';

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

	test('barrels: an entity, a junction and a relationship each throw', async () => {
		const ctx = { cwd: '/', config: null } as never;
		for (const make of [withBadEntity, withBadJunction, () => {
			const root = mkRoot();
			fs.mkdirSync(path.join(root, 'relationships'));
			fs.writeFileSync(path.join(root, 'relationships', 'broken_rel.yaml'), 'relationship:\n  name: broken_rel\n  from: note\n');
			return root;
		}]) {
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
			expect((caught as Error).message).toContain('the pre-flight should have stopped it');
			expect((caught as Error).message).toMatch(/bad\.yaml|broken\.yaml|broken_rel\.yaml/);
		}
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
