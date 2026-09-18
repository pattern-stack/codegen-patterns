/**
 * Golden fixture barrel ↔ emitted model (SEM-3).
 *
 * `test/semantic-golden/schema.ts` is the ONE hand-written file in the golden
 * tree — a stand-in for the generated Drizzle schema barrel, so the checked-in
 * emitted `snapshot/model.ts` can be IMPORTED and executed by
 * `test/integration/semantic-fanout.drizzle.integration.test.ts`.
 *
 * Hand-written means it can drift from the fixtures. These assertions make that
 * impossible to do silently: every table the model references must exist, and
 * every column its analytics tags name must be a real column on that table.
 * Without this the integration test could pass against a stale barrel.
 */

import { describe, expect, it } from 'bun:test';
import { getColumns } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

import { buildAggregateModel } from '../../../../test/semantic-golden/snapshot/model';

const model = buildAggregateModel();

/** db-column names on a table, from the table object itself. */
function dbColumns(table: PgTable): Set<string> {
	return new Set(
		Object.values(getColumns(table)).map((c) => (c as unknown as { name: string }).name),
	);
}

describe('the emitted golden model resolves against the fixture barrel', () => {
	it('every entity in the registry has a table object', () => {
		for (const [name, descriptor] of Object.entries(model.registry)) {
			expect(descriptor.table, `registry.${name}.table`).toBeDefined();
			expect(model.tables[name], `tables.${name}`).toBeDefined();
		}
		expect(Object.keys(model.registry).sort()).toEqual(Object.keys(model.tables).sort());
	});

	it('every analytics field names a real column on its table', () => {
		for (const [entity, agg] of Object.entries(model.analytics)) {
			const columns = dbColumns(model.tables[entity]!);
			for (const [key, meta] of Object.entries(agg.fields)) {
				expect(columns, `${entity}.${key} (column '${meta.column ?? key}')`).toContain(
					meta.column ?? key,
				);
			}
		}
	});

	it('every primary key is a real column', () => {
		for (const [entity, agg] of Object.entries(model.analytics)) {
			expect(dbColumns(model.tables[entity]!), `${entity}.pk`).toContain(agg.pk);
		}
	});

	it('every relationship FK is a real column on the side that holds it', () => {
		for (const [entity, agg] of Object.entries(model.analytics)) {
			for (const [key, rel] of Object.entries(agg.rels)) {
				// belongs_to holds the FK locally; has_many / has_one hold it on the target.
				const holder = rel.kind === 'belongs_to' ? entity : rel.target;
				const table = model.tables[holder];
				expect(table, `${entity}.${key} → ${holder}`).toBeDefined();
				expect(dbColumns(table!), `${entity}.${key} fk '${rel.fk}' on ${holder}`).toContain(
					rel.fk,
				);
			}
		}
	});

	it('every searchable column is a real column', () => {
		for (const [entity, descriptor] of Object.entries(model.registry)) {
			const columns = dbColumns(model.tables[entity]!);
			for (const column of descriptor.searchableColumns) {
				expect(columns, `${entity}.searchableColumns`).toContain(column);
			}
		}
	});

	it('colByDbName is keyed by db name and covers every analytics field', () => {
		for (const [entity, agg] of Object.entries(model.analytics)) {
			const byDbName = model.colByDbName[entity]!;
			for (const [key, meta] of Object.entries(agg.fields)) {
				expect(byDbName[meta.column ?? key], `colByDbName.${entity}.${key}`).toBeDefined();
			}
		}
	});

	it('every catalog metric leg resolves to a derived atomic measure key', () => {
		// The atomic keys the consuming package will derive from the field tags.
		const atomic = new Set<string>();
		for (const agg of Object.values(model.analytics)) {
			for (const [key, meta] of Object.entries(agg.fields)) {
				if (meta.role !== 'measure') continue;
				if (meta.aggs) for (const a of meta.aggs) atomic.add(`${key}.${a}`);
				else if (meta.agg) atomic.add(key);
			}
		}
		const legs: string[] = [];
		const walk = (node: unknown): void => {
			if (typeof node !== 'object' || node === null) return;
			if ('ref' in node) legs.push((node as { ref: string }).ref);
			if ('op' in node) {
				walk((node as { left: unknown }).left);
				walk((node as { right: unknown }).right);
			}
		};
		for (const def of Object.values(model.catalog ?? {})) {
			if (def.kind === 'ratio') legs.push(def.numerator, def.denominator);
			else if (def.kind === 'cumulative') legs.push(def.measure);
			else if (def.kind === 'derived') walk(def.expr);
		}
		expect(legs.length).toBeGreaterThan(0);
		for (const leg of legs) expect([...atomic]).toContain(leg);
	});
});

describe('behavior-contributed columns reach the model (SEM-3)', () => {
	it('emits timestamps columns as dimensions on an entity that declares the behavior', () => {
		// `account.yaml` declares `behaviors: [timestamps]` and does NOT list
		// created_at/updated_at in `fields:` — they come from the behavior.
		expect(model.analytics.account!.fields.created_at).toEqual({
			type: 'datetime',
			role: 'dimension',
			column: 'created_at',
		});
		expect(model.analytics.account!.fields.updated_at!.role).toBe('dimension');
	});

	it('does not invent behavior columns on an entity that declares no behaviors', () => {
		// `contact.yaml` has no `behaviors:` block.
		expect(model.analytics.contact!.fields.created_at).toBeUndefined();
	});

	it('leaves `time` undeclared on behavior columns — the author picks the axis', () => {
		expect(model.analytics.account!.fields.created_at!.time).toBeUndefined();
		// The slice's declared axis is an explicit field tag.
		expect(model.analytics.opportunity!.fields.closed_at!.time).toBe(true);
	});
});
