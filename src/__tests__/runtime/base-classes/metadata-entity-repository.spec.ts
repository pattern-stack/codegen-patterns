/**
 * MetadataEntityRepository.upsertMany with a conflict target — the `match:` fill (RFC-0006 §2.4, #875 S4 review).
 *
 * The insert builds its own statement and does not go through `BaseRepository.create`, so it must call
 * `deriveColumns` itself or a table with a derived column could never be written through it.
 */
import { describe, expect, it, mock } from 'bun:test';
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { MetadataEntityRepository } from '../../../../runtime/base-classes/metadata-entity-repository';
import type { DrizzleClient } from '../../../../runtime/types/drizzle';

const tags = pgTable('tags', {
	id: text('id').primaryKey(),
	entityId: text('entity_id'),
	name: text('name'),
	createdAt: timestamp('created_at'),
	updatedAt: timestamp('updated_at'),
});

interface Tag {
	id: string;
	entityId: string;
	name: string;
}

function makeDb() {
	const captured = { values: [] as unknown[], conflict: [] as unknown[] };
	const query: Record<string, unknown> & PromiseLike<unknown> = {
		then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve),
		catch: () => Promise.resolve([]),
		finally: (cb: () => void) => Promise.resolve([]).finally(cb),
	};
	for (const m of ['insert', 'returning']) query[m] = mock(() => query);
	query['values'] = mock((v: unknown) => {
		captured.values.push(v);
		return query;
	});
	query['onConflictDoUpdate'] = mock((v: unknown) => {
		captured.conflict.push(v);
		return query;
	});
	return { db: query as unknown as DrizzleClient, captured };
}

class TagRepository extends MetadataEntityRepository<Tag, typeof tags, never> {
	readonly table = tags;
	readonly modes: string[] = [];
	protected override deriveColumns(data: Record<string, unknown>, mode: 'create' | 'update'): Record<string, unknown> {
		this.modes.push(mode);
		return { ...data, derivedKind: 'derived' };
	}
}

describe('MetadataEntityRepository.upsertMany with a conflict target', () => {
	it('fills the derived column on the inserted rows and on the conflict SET', async () => {
		const { db, captured } = makeDb();
		const repo = new TagRepository(db as never);
		await repo.upsertMany([{ id: 'a', name: 'x' }, { id: 'b', name: 'y' }], undefined, { conflictTarget: 'id' });

		expect(repo.modes).toEqual(['create', 'create']);
		const values = captured.values[0] as Array<Record<string, unknown>>;
		expect(values.map((v) => v.derivedKind)).toEqual(['derived', 'derived']);
		// `set` is the first row's data, derived value included.
		expect((captured.conflict[0] as { set: Record<string, unknown> }).set.derivedKind).toBe('derived');
	});
});
