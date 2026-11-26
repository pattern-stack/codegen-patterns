/**
 * TGT-1: the drizzle/postgres constraint renderer writes today's text from constraint facts — the strings the
 * goldens pin, one case per shape — and the composers refuse to run without a renderer (never a silent default).
 */

import { describe, expect, it } from 'bun:test';
import { processFieldFeatures } from '../../../templates/entity/new/backend/entity-locals.js';
import { constraintRendererFor } from '../../targets/constraints';
import { drizzlePostgresConstraints as pg } from '../../targets/drizzle/postgres/constraints';
import { TARGET_RENDERERS } from '../../targets/renderers';

describe('drizzle/postgres constraints', () => {
	it('is the pair\'s constraint renderer', () => {
		expect(TARGET_RENDERERS['drizzle/postgres'].constraints).toBe(pg);
		expect(constraintRendererFor({ database: 'postgres', orm: 'drizzle' }, 'test')).toBe(pg);
	});

	it('a column reference is an annotated .references callback (#631)', () => {
		expect(pg.columnReference({ targetExport: 'accounts', targetColumn: 'id' })).toBe(
			'.references((): AnyPgColumn => accounts.id)',
		);
		// belongs_to and junction endpoints carry the referential action (ADR-021).
		expect(pg.columnReference({ targetExport: 'accounts', targetColumn: 'id', onDelete: 'set null' })).toBe(
			".references((): AnyPgColumn => accounts.id, { onDelete: 'set null' })",
		);
	});

	it('an index is index(name).on(<param>.<prop>, …)', () => {
		expect(pg.index({ name: 'deals_stage_idx', props: ['stage'] }, 'tCols')).toBe(
			"index('deals_stage_idx').on(tCols.stage)",
		);
		expect(pg.index({ name: 'x_a_b_idx', props: ['a', 'b'] }, 'tCols')).toBe("index('x_a_b_idx').on(tCols.a, tCols.b)");
	});
});

describe('drizzle/postgres uniques, foreign keys and checks', () => {
	const base = { name: 'n', props: ['tenantId', 'title'], where: null, nullsNotDistinct: false, referenced: false, tenantScoped: false };

	it('plain → uniqueIndex', () => {
		expect(pg.unique(base, 't')).toEqual({ builder: 'uniqueIndex', expr: "uniqueIndex('n').on(t.tenantId, t.title)", comment: null });
	});

	it('NULLS NOT DISTINCT → the unique() table constraint (rc.4: only it carries .nullsNotDistinct())', () => {
		expect(pg.unique({ ...base, nullsNotDistinct: true }, 't').expr).toBe("unique('n').on(t.tenantId, t.title).nullsNotDistinct()");
	});

	it('partial → uniqueIndex(…).where(sql`…`), never NULLS NOT DISTINCT', () => {
		const r = pg.unique(
			{ ...base, nullsNotDistinct: true, tenantScoped: true, where: [{ column: 'deleted_at', prop: 'deletedAt' }, { text: ' IS NULL' }] },
			't',
		);
		expect(r.expr).toBe("uniqueIndex('n').on(t.tenantId, t.title).where(sql`${t.deletedAt} IS NULL`)");
		expect(r.comment).toContain('partial, so NULL-tenant rows never conflict');
	});

	it('a referenced unique (a composite FK target) → unique(…) without NULLS NOT DISTINCT', () => {
		expect(pg.unique({ ...base, props: ['id', 'kind'], referenced: true }, 't')).toEqual({
			builder: 'unique',
			expr: "unique('n').on(t.id, t.kind)",
			comment: null,
		});
	});

	it('a tenant-scoped rule carries the pair\'s note on the NULL tenant', () => {
		expect(pg.unique({ ...base, tenantScoped: true }, 't').comment).toContain('nulls_not_distinct: false');
		expect(pg.unique({ ...base, tenantScoped: true, nullsNotDistinct: true }, 't').comment).toContain('one partition');
	});

	it('a composite foreign key', () => {
		expect(
			pg.foreignKey(
				{ name: 'notes_base_kind_fk', props: ['id', 'kind'], targetExport: 'communications', targetProps: ['id', 'kind'], onDelete: 'cascade' },
				'tCols',
			),
		).toBe(
			"foreignKey({\n      name: 'notes_base_kind_fk',\n      columns: [tCols.id, tCols.kind],\n" +
				"      foreignColumns: [communications.id, communications.kind],\n    }).onDelete('cascade')",
		);
	});

	it('a check', () => {
		expect(
			pg.check({ name: 'c', expression: [{ column: 'kind', prop: 'kind' }, { text: " = 'meeting'" }] }, 'tCols'),
		).toBe("check('c', sql`${tCols.kind} = 'meeting'`)");
	});
});

describe('the composers require the renderer', () => {
	it('processFieldFeatures without a constraint renderer throws', () => {
		expect(() =>
			processFieldFeatures([], {}, { entityName: 'deal', ownNaming: { plural: 'deals' }, entityTableName: 'deals' }, [], new Set()),
		).toThrow(/constraint renderer is required/);
	});
});
