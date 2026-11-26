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

describe('the composers require the renderer', () => {
	it('processFieldFeatures without a constraint renderer throws', () => {
		expect(() =>
			processFieldFeatures([], {}, { entityName: 'deal', ownNaming: { plural: 'deals' }, entityTableName: 'deals' }, [], new Set()),
		).toThrow(/constraint renderer is required/);
	});
});
