/**
 * Semantic emitter — the emitted barrel (SEM-2).
 */

import { GENERATED_BANNER, TYPES_MODULE } from './emit-model';

export const SEMANTIC_INDEX_FILE = 'index.ts';

/** Render `<generated>/semantic/index.ts`. */
export function buildSemanticIndex(): string {
	const typeExport =
		TYPES_MODULE === './types'
			? `export type {
	Additivity,
	Agg,
	AggColType,
	AggEntity,
	AggFieldMeta,
	AggRegistry,
	AggRelationship,
	AggregateModel,
	EntityDescriptor,
	MeasureCatalog,
	MeasureDef,
	RelDescriptor,
} from './types';
`
			: '';
	return `${GENERATED_BANNER}export { buildAggregateModel } from './model';
${typeExport}`;
}
