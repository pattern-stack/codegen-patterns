/**
 * Frontend emitter — shared types (ADR-038, FE-2).
 *
 * The frontend emitter renders the complete frontend tree from the full entity
 * set in one pass (no per-entity hygen runs, no inject/anchor machinery). This
 * module declares the context and per-emit config the string builders consume.
 *
 * Reference design: pattern-stack/pattern-stack `tools/cli/src/pts/codegen/` and
 * pattern-stack/frontend-patterns `src/sync/`. See
 * docs/specs/2026-06-04-frontend-pipeline-rebuild.md.
 */

import type { EntityRegistryEntry } from '../../parser/entity-registry';
import type { ParsedEntity } from '../../analyzer/types';

export type { EntityRegistryEntry } from '../../parser/entity-registry';
export type { ParsedEntity } from '../../analyzer/types';

/**
 * Per-entity sync mode. `offline` (Electric + Dexie) is deferred — see
 * docs/specs/2026-06-04-frontend-pipeline-rebuild.md OQ-6.
 */
export type SyncMode = 'api' | 'electric';

/**
 * Resolved frontend emit configuration. Derived from `codegen.config.yaml`
 * (`frontend.*`, `generate.architecture`, `locations.*`) by the caller (FE-4
 * wires the config loader). FE-2 consumes a plain object so tests can construct
 * it directly without fs.
 */
export interface FrontendEmitConfig {
	/** `frontend.sync.mode` — global default, overridden by per-entity `sync:`. Default 'electric'. */
	globalSyncMode: SyncMode;
	/** `frontend.auth.function` — null disables the auth header (no header lines emitted). */
	authFunction: string | null;
	/** `locations.frontendCollectionsAuth.import` — module the auth fn is imported from. */
	authImport: string;
	/** `frontend.sync.shapeUrl` — Electric shape base path. Default '/v1/shape'. */
	shapeUrl: string;
	/** `frontend.sync.useTableParam` — emit the `params: { table }` shape URL form. */
	useTableParam: boolean;
	/** `frontend.sync.columnMapper` — Electric column mapper fn name, or null. */
	columnMapper: string | null;
	/** `frontend.sync.columnMapperNeedsCall` — call the mapper (`fn()`) vs reference it (`fn`). */
	columnMapperNeedsCall: boolean;
	/** `frontend.sync.apiUrl` — REST base path used when no apiBaseUrlImport. Default '/api'. */
	apiUrl: string;
	/** `frontend.sync.apiBaseUrlImport` — when set, emit `import { API_BASE_URL } from '<x>'` and use it as baseURL. */
	apiBaseUrlImport: string | null;
	/** `frontend.parsers` — Electric parser block: column type → parser fn source. */
	parsers: Record<string, string>;
	/** `generate.architecture` — drives the REST update verb (clean → PUT, clean-lite-ps → PATCH). */
	architecture: 'clean' | 'clean-lite-ps';
	/** `locations.dbEntities.import` — module the Zod schema + entity type are imported from. */
	dbEntitiesImport: string;
	/** `frontend.catalog.categories` — ordered display groups for the providers catalog. */
	catalogCategories: CatalogCategoryConfig[];
	/**
	 * `frontend.fields.textareaThreshold` — string→textarea inference cutoff;
	 * null disables the heuristic (bounded strings stay `text` unless the author
	 * sets `ui_type: textarea`). Default 500.
	 */
	textareaThreshold: number | null;
}

/** One `frontend.catalog.categories[]` entry (blurb defaulted to '' by the schema). */
export interface CatalogCategoryConfig {
	id: string;
	name: string;
	blurb: string;
}

/**
 * The slice of a provider definition the catalog emission consumes — slug +
 * display metadata only, decoupled from the full `ProviderDefinitionSchema`
 * shape so emitter tests construct it directly without YAML.
 */
export interface ProviderCatalogInput {
	slug: string;
	displayName?: string;
	surfaces: string[];
	status: 'active' | 'planned';
	display?: { category?: string; blurb?: string; hint?: string };
}

/**
 * Whole-set emit context. `entities` is the full registry set in deterministic
 * (name-sorted) order; the builders never re-sort, so the caller's order is the
 * emitted order. {@link sortEntities} produces the canonical order.
 *
 * The registry (`entities`) stays the only naming source. `parsed` — keyed by
 * entity name — supplies the data the registry doesn't carry: fields (FE-3
 * field metadata), relationships (FE-3 FK resolvers), behaviors (timestamps),
 * and `expose` (write capabilities). FK target names are still resolved against
 * the registry, never re-derived from a parsed string. Entities present in
 * `entities` but absent from `parsed` (e.g. a registry-only test fixture) emit
 * empty field/relationship sets.
 */
export interface FrontendEmitContext {
	entities: EntityRegistryEntry[];
	parsed: Map<string, ParsedEntity>;
	config: FrontendEmitConfig;
	/**
	 * Loaded provider definitions (`definitions/providers/*.yaml`), when the
	 * project has any — drives `providers.ts` emission. Absent/empty ⇒ no
	 * catalog is emitted and the root barrel omits the export.
	 */
	providers?: ProviderCatalogInput[];
}

/**
 * Canonical entity order for deterministic emission: ascending by `name`.
 * Returns a new array (does not mutate the input).
 */
export function sortEntities(entities: EntityRegistryEntry[]): EntityRegistryEntry[] {
	return [...entities].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve an entity's effective sync mode: per-entity `sync:` wins, else the
 * global default from config.
 */
export function resolveSyncMode(
	entity: EntityRegistryEntry,
	config: FrontendEmitConfig,
): SyncMode {
	return entity.sync ?? config.globalSyncMode;
}
