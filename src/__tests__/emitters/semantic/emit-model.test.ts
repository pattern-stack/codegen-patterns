/**
 * Semantic emitter — rendering units (SEM-2).
 *
 * The golden snapshot pins the whole tree; this pins the properties that must
 * survive a refactor of the renderer itself — chiefly that the types module is
 * named in exactly ONE place, and that it is the published package.
 */

import { describe, expect, it } from 'bun:test';

import {
	buildSemanticIndex,
	buildSemanticModelSource,
	emitSemanticModel,
	QUERY_SURFACE_MODULE,
} from '../../../emitters/semantic/index';
import type { SemanticEmitContext, SemanticModel } from '../../../emitters/semantic/types';

const emptyModel: SemanticModel = { entities: [], metrics: [], warnings: [] };

describe('QUERY_SURFACE_MODULE is the single name of the package', () => {
	it('is the published semantic-query package (SEM-4)', () => {
		expect(QUERY_SURFACE_MODULE).toBe('@pattern-stack/query-surface');
	});

	it('is the only non-drizzle, non-schema specifier the model renders', () => {
		const source = buildSemanticModelSource(emptyModel);
		const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
		// The model legitimately imports drizzle and the schema barrel; every
		// OTHER specifier must be QUERY_SURFACE_MODULE — no relative types module.
		const packageSpecifiers = specifiers.filter(
			(s) => s !== 'drizzle-orm' && s !== 'drizzle-orm/pg-core' && s !== '../schema',
		);
		expect(packageSpecifiers).toEqual([QUERY_SURFACE_MODULE]);
	});

	it('the emitted barrel re-exports the vocabulary from QUERY_SURFACE_MODULE', () => {
		const index = buildSemanticIndex();
		// Consumers import types from the barrel, so the re-export follows the
		// constant.
		expect(index).toContain(`} from '${QUERY_SURFACE_MODULE}';`);
		expect(index).toContain('\tAggregateModel,');
		expect(index).toContain("export { buildAggregateModel } from './model';");
	});
});

describe('the catalog (#734)', () => {
	// The engine resolves `{ ref }` only from `model.catalog`, so the atomic
	// entries must be in it — but the package owns the tag → key rule, so the
	// model CALLS it rather than carrying the entries (ADR-045, 2026-10-04).
	const withEntity: SemanticModel = {
		entities: [
			{
				name: 'deal',
				tableVar: 'deals',
				tableName: 'deals',
				primaryKey: 'id',
				relationships: {},
				fields: {
					amount: { type: 'number', role: 'measure', aggs: ['sum'], additivity: 'additive', column: 'amount' },
				},
				searchableColumns: [],
				kind: 'entity',
			},
		],
		metrics: [{ name: 'avg_deal', kind: 'ratio', numerator: 'amount.sum', denominator: 'amount.sum' }],
		warnings: [],
	};

	for (const [label, model] of [
		['an empty model', emptyModel],
		['a model with entities and a composite', withEntity],
	] as const) {
		it(`is measuresFromRegistry(analytics) with the composites over it — ${label}`, () => {
			const source = buildSemanticModelSource(model);
			expect(source).toContain(
				'const catalog: MeasureCatalog = { ...measuresFromRegistry(analytics), ...composites };',
			);
			expect(source).toMatch(
				new RegExp(`import \\{\\n\\tmeasuresFromRegistry,[^}]*\\} from '${QUERY_SURFACE_MODULE}';`),
			);
			// A call, never the entries: one owner of the rule.
			expect(source).not.toContain("kind: 'atomic'");
		});
	}

	it('declares the composites by name', () => {
		const source = buildSemanticModelSource(withEntity);
		expect(source).toContain(
			"const composites: MeasureCatalog = {\n\tavg_deal: { kind: 'ratio', numerator: 'amount.sum', denominator: 'amount.sum' },\n};",
		);
	});
});

describe('emitted file set', () => {
	const ctx: SemanticEmitContext = {
		entities: [],
		parsed: new Map(),
		junctions: [],
	};

	it('is the model and its barrel — no vendored types module', () => {
		const result = emitSemanticModel(ctx, '/tmp/unused-sem2', { dryRun: true });
		const files = Object.keys(result.contents).sort();
		expect(files).toEqual(['index.ts', 'model.ts']);
	});

	it('a dry run writes nothing but still renders every file', () => {
		const result = emitSemanticModel(ctx, '/tmp/unused-sem2', { dryRun: true });
		expect(result.written).toEqual([]);
		expect(Object.keys(result.contents).length).toBeGreaterThan(0);
	});
});

describe('rendering', () => {
	it('emits a valid empty model when there are no entities', () => {
		const source = buildSemanticModelSource(emptyModel);
		expect(source).toContain('const registry: Record<string, EntityDescriptor> = {};');
		expect(source).toContain('export function buildAggregateModel(): AggregateModel {');
	});

	it('carries the @generated banner on every file', () => {
		expect(buildSemanticModelSource(emptyModel)).toStartWith('// @generated');
		expect(buildSemanticIndex()).toStartWith('// @generated');
	});

	it('quotes a key that is not a bare identifier', () => {
		const source = buildSemanticModelSource({
			entities: [
				{
					name: 'weird-name',
					tableVar: 'weirdNames',
					tableName: 'weird_names',
					primaryKey: 'id',
					relationships: {},
					fields: {},
					searchableColumns: [],
					kind: 'entity',
				},
			],
			metrics: [],
			warnings: [],
		});
		expect(source).toContain("'weird-name': schema.weirdNames,");
	});
});
