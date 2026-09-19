/**
 * Semantic emitter — the emitted barrel (SEM-2).
 */

import { GENERATED_BANNER, TYPES_MODULE } from './emit-model';

export const SEMANTIC_INDEX_FILE = 'index.ts';

/**
 * Render `<generated>/semantic/index.ts`.
 *
 * The type re-export names {@link TYPES_MODULE} rather than `./types`, so the
 * barrel keeps exporting the vocabulary when the mirror is retired for the
 * published package (SEM-4) — consumers importing types from the barrel never
 * notice the switch. Every name below is exported from the package root.
 */
export function buildSemanticIndex(): string {
	return `${GENERATED_BANNER}export { buildAggregateModel } from './model';
export type {
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
} from '${TYPES_MODULE}';
`;
}
