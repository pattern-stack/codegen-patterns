/**
 * Semantic emitter — rendering units (SEM-2).
 *
 * The golden snapshot pins the whole tree; this pins the properties that must
 * survive a refactor of the renderer itself — chiefly that the types module is
 * named in exactly ONE place, so switching from the vendored mirror to the
 * published package cannot be done halfway.
 */

import { describe, expect, it } from 'bun:test';

import {
	buildSemanticIndex,
	buildSemanticModelSource,
	buildSemanticTypes,
	emitSemanticModel,
	SEMANTIC_TYPES_FILE,
	TYPES_MODULE,
} from '../../../emitters/semantic/index';
import type { SemanticEmitContext, SemanticModel } from '../../../emitters/semantic/types';

const emptyModel: SemanticModel = { entities: [], metrics: [], warnings: [] };

describe('TYPES_MODULE is the single name of the types module', () => {
	it('is the vendored mirror until the package publishes', () => {
		// Flipping this is SEM-4's retirement, not a one-line change — the full
		// list of edits is in emit-types.ts's header and docs/specs/SEM-2.md §4.
		expect(TYPES_MODULE).toBe('./types');
	});

	it('is the only type-import specifier the model renders', () => {
		const source = buildSemanticModelSource(emptyModel);
		const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
		// The model legitimately imports drizzle and the schema barrel; every
		// OTHER specifier must be TYPES_MODULE. A second hard-coded './types'
		// somewhere would survive the switch and break the build.
		const typeSpecifiers = specifiers.filter(
			(s) => s !== 'drizzle-orm' && s !== 'drizzle-orm/pg-core' && s !== '../schema',
		);
		expect(typeSpecifiers).toEqual([TYPES_MODULE]);
	});

	it('the emitted barrel re-exports the vocabulary from TYPES_MODULE, whichever it is', () => {
		const index = buildSemanticIndex();
		// Consumers import types from the barrel; retiring the mirror must not
		// take them away, so the re-export follows the constant.
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

	it('includes types.ts only while the vocabulary is vendored', () => {
		const result = emitSemanticModel(ctx, '/tmp/unused-sem2', { dryRun: true });
		const files = Object.keys(result.contents).sort();
		expect(files).toEqual(
			TYPES_MODULE === './types'
				? ['index.ts', 'model.ts', SEMANTIC_TYPES_FILE]
				: ['index.ts', 'model.ts'],
		);
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
		expect(buildSemanticTypes()).toStartWith('// @generated');
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
