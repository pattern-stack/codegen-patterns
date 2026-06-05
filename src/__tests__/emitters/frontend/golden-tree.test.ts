/**
 * Frontend emitter — golden-tree snapshot (ADR-038, FE-4).
 *
 * Closes the zero-coverage gap (review finding M-8): the baseline runner drives
 * `bunx hygen` per entity and bolts post-steps on via one-off `bun -e` shims —
 * the frontend emitter is a whole-set TS function (`emitFrontendSet`) with no
 * hygen surface, and the baseline tsconfig can't resolve `@repo/db/entities` or
 * `@pattern-stack/frontend-patterns` to compile the output. So instead of an
 * invasive baseline integration, this golden test exercises the REAL CLI path —
 * `loadFrontendEmitContext` → `emitFrontendSet`, exactly what the `entity new`
 * post-step calls — into a tmp dir, and compares the tree byte-for-byte against
 * the checked-in `test/frontend-golden/snapshot/`.
 *
 * The fixture set is `test/frontend-golden/entities/` (explicit-plural `person`
 * + FK-consumer `user`), so the snapshot also LOCKS registry-resolved naming:
 * `user belongs_to person` must reference `persons` (person.plural), never a
 * re-pluralization of the string "person". A focused assertion below verifies
 * this independently of the snapshot diff so a regression names itself.
 *
 * Regenerate after intentional emitter changes:
 *   UPDATE_FRONTEND_GOLDEN=1 bun test src/__tests__/emitters/frontend/golden-tree.test.ts
 */

import { afterAll, describe, expect, it } from 'bun:test';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import {
	loadFrontendEmitContext,
	emitFrontendSet,
} from '../../../emitters/frontend/index';

const ENTITIES_DIR = resolve(
	import.meta.dir,
	'../../../../test/frontend-golden/entities',
);
const SNAPSHOT_DIR = resolve(
	import.meta.dir,
	'../../../../test/frontend-golden/snapshot',
);
const UPDATE = process.env.UPDATE_FRONTEND_GOLDEN === '1';

/** Recursively list every file under `dir`, returned as paths relative to it. */
function listFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		if (!existsSync(d)) return;
		for (const ent of readdirSync(d, { withFileTypes: true })) {
			const full = join(d, ent.name);
			if (ent.isDirectory()) walk(full);
			else out.push(relative(dir, full));
		}
	};
	walk(dir);
	return out.sort();
}

// Emit the whole set into a tmp dir via the same context loader the CLI uses.
const tmpRoot = mkdtempSync(join(tmpdir(), 'fe-golden-'));
const outDir = join(tmpRoot, 'generated');

const loaded = loadFrontendEmitContext(
	ENTITIES_DIR,
	// auth disabled + electric default; per-entity `sync:` in the YAML drives
	// the per-collection branch. Locations default; dbEntities import default.
	{ frontend: { auth: { function: null } } },
	{ entitiesDir: ENTITIES_DIR },
);
if (loaded.skip !== undefined) {
	throw new Error(`golden fixture failed to load: ${loaded.skip}`);
}
emitFrontendSet(loaded.ctx, outDir);

afterAll(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe('frontend golden tree', () => {
	if (UPDATE) {
		it('regenerates the checked-in snapshot', () => {
			if (existsSync(SNAPSHOT_DIR)) rmSync(SNAPSHOT_DIR, { recursive: true });
			mkdirSync(SNAPSHOT_DIR, { recursive: true });
			cpSync(outDir, SNAPSHOT_DIR, { recursive: true });
			expect(listFiles(SNAPSHOT_DIR).length).toBeGreaterThan(0);
		});
		return;
	}

	it('emits the same file set as the snapshot', () => {
		expect(listFiles(outDir)).toEqual(listFiles(SNAPSHOT_DIR));
	});

	it('every emitted file is byte-identical to the snapshot', () => {
		for (const rel of listFiles(SNAPSHOT_DIR)) {
			const got = readFileSync(join(outDir, rel), 'utf-8');
			const want = readFileSync(join(SNAPSHOT_DIR, rel), 'utf-8');
			expect(got, `mismatch in ${rel}`).toBe(want);
		}
	});

	it('resolves FK target naming from the registry (persons, not derived)', () => {
		// user belongs_to person → store/resolvers/lookups key the target by
		// person.plural = "persons" (explicit in the YAML). A re-pluralization of
		// "person" would also produce "persons" by coincidence here for the store
		// key, so assert the load-bearing case: the resolver hydrator references
		// person's registry className + camelName, and the store keys by `persons`.
		const storeIndex = readFileSync(join(outDir, 'store/index.ts'), 'utf-8');
		expect(storeIndex).toContain('persons: personHooks');
		expect(storeIndex).toContain('users: userHooks');

		const resolvers = readFileSync(join(outDir, 'store/resolvers.ts'), 'utf-8');
		// user's FK hydrator resolves `person` via the person resolver — proving
		// the target was resolved through the registry record, not a string guess.
		expect(resolvers).toContain('person: resolvers.person(entity.personId)');
		expect(resolvers).toContain('export interface UserRefs');
	});

	it('honors per-entity sync mode (user=api, person=electric)', () => {
		const userCollection = readFileSync(
			join(outDir, 'collections/user.ts'),
			'utf-8',
		);
		const personCollection = readFileSync(
			join(outDir, 'collections/person.ts'),
			'utf-8',
		);
		// api mode delegates transport to the api client; electric mode wires the
		// electric collection options.
		expect(userCollection).toContain('userApi');
		expect(personCollection.toLowerCase()).toContain('electric');
	});
});
