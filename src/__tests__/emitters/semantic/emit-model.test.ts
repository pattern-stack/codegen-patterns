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
	TYPES_MODULE,
} from '../../../emitters/semantic/index';
import type { SemanticEmitContext, SemanticModel } from '../../../emitters/semantic/types';

const emptyModel: SemanticModel = { entities: [], metrics: [], warnings: [] };

describe('TYPES_MODULE is the single name of the types module', () => {
	it('is the published semantic-query package (SEM-4)', () => {
		expect(TYPES_MODULE).toBe('@pattern-stack/query-surface');
	});

	it('is the only type-import specifier the model renders', () => {
		const source = buildSemanticModelSource(emptyModel);
		const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
		// The model legitimately imports drizzle and the schema barrel; every
		// OTHER specifier must be TYPES_MODULE — no relative types module.
		const typeSpecifiers = specifiers.filter(
			(s) => s !== 'drizzle-orm' && s !== 'drizzle-orm/pg-core' && s !== '../schema',
		);
		expect(typeSpecifiers).toEqual([TYPES_MODULE]);
	});

	it('the emitted barrel re-exports the vocabulary from TYPES_MODULE', () => {
		const index = buildSemanticIndex();
		// Consumers import types from the barrel, so the re-export follows the
		// constant.
		expect(index).toContain(`} from '${TYPES_MODULE}';`);
		expect(index).toContain('\tAggregateModel,');
		expect(index).toContain("export { buildAggregateModel } from './model';");
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
