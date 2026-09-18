/**
 * Relations emitter — golden manifest snapshot (ADR-044, REL-1).
 *
 * Exercises the REAL post-step path — `loadRelationsEmitContext` →
 * `emitRelationsManifest`, exactly what `entity new` calls — into a tmp dir, and
 * compares the written file byte-for-byte against the checked-in
 * `test/relations-golden/snapshot/relations.ts`.
 *
 * The fixture set (`test/relations-golden/`) covers every emission rule in one
 * manifest: self-referential belongs_to, NOT NULL vs nullable belongs_to, an
 * explicit relationship `nullable:` overriding its field, has_many, has_one, an
 * irregular explicit plural (`persons`, which `pluralize` would render
 * "people"), and a junction's four derived edges.
 *
 * Regenerate after intentional emitter changes:
 *   UPDATE_RELATIONS_GOLDEN=1 bun test src/__tests__/emitters/relations/golden-manifest.test.ts
 */

import { afterAll, describe, expect, it } from 'bun:test';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
	emitRelationsManifest,
	loadRelationsEmitContext,
} from '../../../emitters/relations/index';

const GOLDEN_ROOT = resolve(import.meta.dir, '../../../../test/relations-golden');
const ENTITIES_DIR = join(GOLDEN_ROOT, 'entities');
const JUNCTIONS_DIR = join(GOLDEN_ROOT, 'junctions');
const SNAPSHOT_FILE = join(GOLDEN_ROOT, 'snapshot', 'relations.ts');
const UPDATE = process.env.UPDATE_RELATIONS_GOLDEN === '1';

const tmpRoot = mkdtempSync(join(tmpdir(), 'rel-golden-'));
const outDir = join(tmpRoot, 'generated');

const { ctx } = loadRelationsEmitContext(
	GOLDEN_ROOT,
	{},
	{ entitiesDir: ENTITIES_DIR, junctionsDir: JUNCTIONS_DIR },
);
const result = emitRelationsManifest(ctx, outDir);

afterAll(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe('relations golden manifest', () => {
	if (UPDATE) {
		it('regenerates the checked-in snapshot', () => {
			mkdirSync(join(GOLDEN_ROOT, 'snapshot'), { recursive: true });
			cpSync(result.file, SNAPSHOT_FILE);
			expect(existsSync(SNAPSHOT_FILE)).toBe(true);
		});
		return;
	}

	const emitted = readFileSync(result.file, 'utf-8');

	it('loads every fixture (guards against a silently empty sweep)', () => {
		expect(ctx.entities.map((e) => e.name)).toEqual([
			'account',
			'contact',
			'note',
			'opportunity',
			'person',
		]);
		expect(ctx.junctions).toHaveLength(1);
		expect(result.warnings).toEqual([]);
	});

	it('is byte-identical to the snapshot', () => {
		expect(emitted).toBe(readFileSync(SNAPSHOT_FILE, 'utf-8'));
	});

	it('is idempotent — a second emit produces the same bytes', () => {
		const second = emitRelationsManifest(ctx, join(tmpRoot, 'again'));
		expect(second.content).toBe(emitted);
	});

	it('resolves the target table from the registry, not by re-pluralizing', () => {
		// contact.people → person, whose YAML declares `plural: persons`.
		// `pluralize('person')` is "people"; emitting that would not compile.
		expect(emitted).toContain('people: r.many.persons(');
		expect(emitted).not.toContain('r.many.people(');
	});

	it('emits no `alias` — every relation carries explicit from/to (R2)', () => {
		expect(emitted).not.toContain('alias:');
		const relationLines = emitted
			.split('\n')
			.filter((l) => /^\t\t\w+: r\.(one|many)\./.test(l));
		expect(relationLines.length).toBeGreaterThan(0);
		for (const line of relationLines) {
			expect(line, `missing from/to: ${line}`).toContain('from: r.');
			expect(line, `missing from/to: ${line}`).toContain('to: r.');
		}
	});

	it('emits the junction many-to-many as a .through() hop on both parents', () => {
		expect(emitted).toContain(
			'contacts: r.many.contacts({ from: r.opportunities.id.through(r.opportunityContacts.opportunityId), to: r.contacts.id.through(r.opportunityContacts.contactId) }),',
		);
		expect(emitted).toContain(
			'opportunities: r.many.opportunities({ from: r.contacts.id.through(r.opportunityContacts.contactId), to: r.opportunities.id.through(r.opportunityContacts.opportunityId) }),',
		);
	});
});
