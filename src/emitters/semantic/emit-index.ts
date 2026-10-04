/**
 * Semantic emitter — the emitted barrel (SEM-2).
 */

import { GENERATED_BANNER, QUERY_SURFACE_MODULE } from './emit-model';

export const SEMANTIC_INDEX_FILE = 'index.ts';

/**
 * Render `<generated>/semantic/index.ts`.
 *
 * The type re-export names {@link QUERY_SURFACE_MODULE}, so consumers can import the
 * vocabulary from the barrel alongside the model. Every name below is exported
 * from the package root.
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
} from '${QUERY_SURFACE_MODULE}';
`;
}
