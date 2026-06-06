/**
 * Frontend emitter — config + registry → emit context (ADR-038, FE-4).
 *
 * `loadFrontendEmitContext` is the single place the CLI (`entity new` post-step
 * + `gen-all`) calls to turn a loaded `codegen.config.yaml` into a ready-to-emit
 * {@link FrontendEmitContext} + output directory. It:
 *
 *  1. loads the cross-entity naming registry (`loadEntityRegistry`) — the only
 *     NAMING source, so FK targets resolve against the target's own YAML;
 *  2. loads the parsed entity map (`loadEntities`, keyed by name) — fields,
 *     relationships, behaviors, `expose`;
 *  3. maps the validated `frontend:` block + `generate.architecture` + the
 *     `locations.*` path/import pairs into a {@link FrontendEmitConfig}.
 *
 * Zero entities ⇒ `{ skip }` with a human-readable reason (nothing to emit). The
 * caller surfaces the reason like the sibling post-steps do.
 *
 * Locations are read straight off the passed `config` object (with the same
 * defaults `src/config/locations.mjs` declares) rather than importing that
 * module's `LOCATIONS` singleton — the singleton binds `process.cwd()` at import
 * time, which is wrong under the CLI's `--cwd`. Reading from the in-hand config
 * keeps the emitter cwd-correct and free of the `.mjs` layer.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { loadEntityRegistry } from '../../parser/entity-registry';
import { loadEntities } from '../../parser/load-entities';
import type { ParsedEntity } from '../../analyzer/types';
import { FrontendConfigSchema } from '../../schema/codegen-config.schema';
import { findYamlFiles } from '../../utils/find-yaml-files';
import { loadProvidersFromYaml } from '../../utils/yaml-loader';
import type {
	EntityRegistryEntry,
	FrontendEmitConfig,
	FrontendEmitContext,
	ProviderCatalogInput,
} from './types';
import { sortEntities } from './types';

// ---------------------------------------------------------------------------
// Location defaults (mirror src/config/locations.mjs)
// ---------------------------------------------------------------------------

/** Default `locations.dbEntities` — the module entity types + Zod schemas import from. */
const DEFAULT_DB_ENTITIES = {
	path: 'packages/db/src/entities',
	import: '@repo/db/entities',
} as const;

/** Default `locations.frontendGenerated` — the whole-set output root. */
const DEFAULT_FRONTEND_GENERATED = {
	path: 'apps/frontend/src/generated',
	import: '@/generated',
} as const;

/** Default `locations.frontendCollectionsAuth` — the auth-fn import module. */
const DEFAULT_FRONTEND_COLLECTIONS_AUTH = {
	path: 'apps/frontend/src/lib/collections/auth',
	import: '@/lib/collections/auth',
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The slice of the loaded config `loadFrontendEmitContext` reads. The full
 * `frontend` block is always populated by the config loader (defaults applied),
 * but typed optional here so callers can pass a partially-shaped config.
 */
export interface FrontendConfigInput {
	generate?: { architecture?: 'clean' | 'clean-lite-ps' } & Record<string, unknown>;
	frontend?: unknown;
	locations?: Record<string, { path?: string; import?: string } | undefined>;
	paths?: { entities_dir?: string; providers?: string } & Record<string, unknown>;
	[key: string]: unknown;
}

export type LoadFrontendEmitContextResult =
	| { skip: undefined; ctx: FrontendEmitContext; outDir: string }
	| { skip: string; ctx?: undefined; outDir?: undefined };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a `locations.<key>` entry from config, falling back to the bundled
 * default. Mirrors `buildLocations` in `locations.mjs` (shallow per-key merge).
 */
function resolveLocation(
	config: FrontendConfigInput,
	key: string,
	fallback: { path: string; import: string },
): { path: string; import: string } {
	const override = config.locations?.[key];
	return {
		path: override?.path ?? fallback.path,
		import: override?.import ?? fallback.import,
	};
}

/**
 * Map the validated `frontend:` block + architecture + locations into the flat
 * {@link FrontendEmitConfig} the string builders consume.
 *
 * The raw `frontend` value is re-parsed through {@link FrontendConfigSchema} so
 * defaults are applied uniformly whether the caller passed a fully-loaded config
 * (the CLI path — already defaulted) or a partial object (tests). Re-parsing is
 * idempotent on already-valid data. An explicit `auth.function: null` survives
 * (Zod `.default()` only fires on `undefined`), preserving the "present-but-null
 * disables" semantics; an absent block defaults to `'getAuthorizationHeader'`.
 */
export function mapFrontendEmitConfig(config: FrontendConfigInput): FrontendEmitConfig {
	const parsed = FrontendConfigSchema.safeParse(config.frontend ?? {});
	const fe = parsed.success ? parsed.data : FrontendConfigSchema.parse({});

	const dbEntities = resolveLocation(config, 'dbEntities', DEFAULT_DB_ENTITIES);
	const collectionsAuth = resolveLocation(
		config,
		'frontendCollectionsAuth',
		DEFAULT_FRONTEND_COLLECTIONS_AUTH,
	);
	const architecture =
		config.generate?.architecture === 'clean-lite-ps' ? 'clean-lite-ps' : 'clean';

	return {
		globalSyncMode: fe.sync.mode,
		// auth.function: absent → 'getAuthorizationHeader' (schema default), explicit
		// null → disabled (no header lines emitted).
		authFunction: fe.auth.function,
		authImport: collectionsAuth.import,
		shapeUrl: fe.sync.shapeUrl,
		useTableParam: fe.sync.useTableParam,
		columnMapper: fe.sync.columnMapper,
		columnMapperNeedsCall: fe.sync.columnMapperNeedsCall,
		apiUrl: fe.sync.apiUrl,
		apiBaseUrlImport: fe.sync.apiBaseUrlImport,
		parsers: fe.parsers,
		architecture,
		dbEntitiesImport: dbEntities.import,
		catalogCategories: fe.catalog.categories,
		textareaThreshold: fe.fields.textareaThreshold,
	};
}

/**
 * Load provider definitions for the catalog emission. Resolves the providers
 * dir the same way the Track D CLI step does (`paths.providers`, default
 * `definitions/providers`); a missing dir or zero loadable files ⇒ `[]` (no
 * catalog emitted). Load FAILURES are ignored here by design — the provider
 * codegen step owns reporting them; the catalog just emits from whatever
 * parses.
 */
export function loadProviderCatalogInputs(
	cwd: string,
	config: FrontendConfigInput,
): ProviderCatalogInput[] {
	const providersDir = path.resolve(
		cwd,
		config.paths?.providers ?? 'definitions/providers',
	);
	if (!existsSync(providersDir) || !statSync(providersDir).isDirectory()) {
		return [];
	}
	const files = findYamlFiles(providersDir);
	if (files.length === 0) return [];

	return loadProvidersFromYaml(files).successes.map((s) => ({
		slug: s.definition.slug,
		displayName: s.definition.display_name,
		surfaces: s.definition.surfaces,
		status: s.definition.status,
		display: s.definition.display,
	}));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build the frontend emit context from a project root + loaded config.
 *
 * @param cwd     Project root (the CLI's `--cwd`, NOT `process.cwd()`).
 * @param config  The loaded `codegen.config.yaml` (frontend block fully
 *                defaulted by the config loader).
 * @param opts.entitiesDir  Override the entities directory (default
 *                `<cwd>/<paths.entities_dir | 'entities'>`).
 * @returns `{ ctx, outDir }` ready for `emitFrontendSet`, or `{ skip }` when
 *          there are no entities to emit.
 */
export function loadFrontendEmitContext(
	cwd: string,
	config: FrontendConfigInput,
	opts: { entitiesDir?: string } = {},
): LoadFrontendEmitContextResult {
	const entitiesDir =
		opts.entitiesDir ??
		path.resolve(cwd, config.paths?.entities_dir ?? 'entities');

	const { registry } = loadEntityRegistry(entitiesDir);
	const entities: EntityRegistryEntry[] = sortEntities([...registry.values()]);

	if (entities.length === 0) {
		return {
			skip: `no entities found in ${path.relative(cwd, entitiesDir) || entitiesDir}`,
		};
	}

	const parsedList = loadEntities(entitiesDir).entities;
	const parsed: Map<string, ParsedEntity> = new Map(
		parsedList.map((p) => [p.name, p]),
	);

	const emitConfig = mapFrontendEmitConfig(config);
	const providers = loadProviderCatalogInputs(cwd, config);
	const generated = resolveLocation(
		config,
		'frontendGenerated',
		DEFAULT_FRONTEND_GENERATED,
	);
	const outDir = path.resolve(cwd, generated.path);

	return {
		skip: undefined,
		ctx: { entities, parsed, config: emitConfig, providers },
		outDir,
	};
}
