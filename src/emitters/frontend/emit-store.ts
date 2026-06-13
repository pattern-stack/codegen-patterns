/**
 * Frontend emitter — whole-set store: createStore + FK resolvers + lookups
 * (ADR-038, FE-3).
 *
 * Ports pts `store.ts.j2` / `store_index.ts.j2` / `resolvers.ts.j2` /
 * `lookups.ts.j2`, with two divergences (recorded in the parent spec):
 *
 *  - **Keyed by PLURAL, not table.** pts keyed `entities:`/`collections:` by
 *    `table_name`. Table can diverge from plural (`entity.table` is independent
 *    of `entity.plural`); the registry's plural is the stable cross-entity name
 *    family, so we key by plural and `store.<plural>.useList()` reads cleanly.
 *
 *  - **Self-contained resolvers/lookups.** The published
 *    `@pattern-stack/frontend-patterns` (`0.2.0-alpha.18`) exports ONLY
 *    `createStore` (which builds `store.resolve` / `store.lookups` internally) —
 *    it does NOT export `createResolvers` / `buildLookups` / `createLookups` /
 *    `EntityLookup`, which the pts templates imported. We therefore emit the
 *    resolver/lookup modules as fully self-contained code with the same
 *    semantics (FK resolve = `collection.state.get(fkValue)`); they layer typed
 *    `<Class>Refs` hydration on top of the registry-resolved names. Nothing is
 *    imported from the package beyond `createStore`.
 *
 * Resolver/lookup emission considers only `belongs_to` relationships whose
 * target exists in the registry (the old `existingBelongsTo` semantics).
 */

import { join } from 'node:path';
import type { ParsedRelationship } from '../../analyzer/types';
import type { EntityRegistryEntry, FrontendEmitContext } from './types';
import { sortEntities } from './types';
import { withBanner, writeFile } from './emit-utils';

const SOURCE_DESC_SET = 'the entity set';

/**
 * A belongs_to relationship whose target is in the registry, paired with the
 * target's registry naming record (so display names are never re-pluralized).
 */
interface ResolvableRel {
	/** relationship property name on the owning entity (camelCase as authored). */
	propertyName: string;
	/** FK field on the owning entity (camelCase). */
	fieldNameCamel: string;
	/** target entity registry record. */
	target: EntityRegistryEntry;
}

const CAMEL = (s: string): string =>
	s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * Resolve an entity's belongs_to relationships to {@link ResolvableRel}s,
 * dropping any whose target is not in the registry (old `existingBelongsTo`).
 * Sorted by property name for determinism.
 */
export function resolvableRels(
	entity: EntityRegistryEntry,
	ctx: FrontendEmitContext,
): ResolvableRel[] {
	const parsed = ctx.parsed.get(entity.name);
	if (!parsed) return [];

	const registryByName = new Map(ctx.entities.map((e) => [e.name, e]));

	const out: ResolvableRel[] = [];
	for (const rel of parsed.relationships.values()) {
		if (rel.type !== 'belongs_to') continue;
		const target = registryByName.get(rel.target);
		if (!target) continue; // target not in the set — skip (existingBelongsTo)
		out.push({
			propertyName: CAMEL(rel.name),
			fieldNameCamel: CAMEL(fkField(rel)),
			target,
		});
	}
	out.sort((a, b) => a.propertyName.localeCompare(b.propertyName));
	return out;
}

/** The FK column for a belongs_to relationship (`foreign_key` or `<target>_id`). */
function fkField(rel: ParsedRelationship): string {
	return rel.foreignKey && rel.foreignKey.length > 0
		? rel.foreignKey
		: `${rel.target}_id`;
}

/**
 * Entities to FULL-FETCH (`api.listAll()` → the whole table) when hydrating the
 * cross-entity lookup maps and the resolver cache.
 *
 * Full-fetching EVERY entity on the first `useData` mount is the LANDMINE-1 trap:
 * a large table with an unbounded text/body column (e.g. tens of thousands of
 * emails × `bodyHtml`) pulls hundreds of MB into the renderer and OOM-kills it,
 * on every route — even ones that never read it.
 *
 * Rule: full-fetch an entity only if it is a LOOKUP TARGET (some belongs_to
 * resolves it by id → it backs a FieldMeta `reference`) OR it has no unbounded
 * text column (cheap to page). Heavy, non-target entities are seeded from current
 * collection state instead — nothing resolves them by id, so the current page is
 * all any consumer can use. "Heavy" = a `text` field, or a `string` field with no
 * `max_length` (emitted as unbounded TEXT).
 */
export function lookupFullFetchNames(ctx: FrontendEmitContext): Set<string> {
	const referenceTargets = new Set<string>();
	for (const e of ctx.entities) {
		for (const r of resolvableRels(e, ctx)) referenceTargets.add(r.target.name);
	}
	const out = new Set<string>();
	for (const e of ctx.entities) {
		const parsed = ctx.parsed.get(e.name);
		const hasUnboundedText = parsed
			? Array.from(parsed.fields.values()).some(
					(f) =>
						f.type === 'text' ||
						(f.type === 'string' && f.constraints.maxLength === undefined),
				)
			: false;
		if (referenceTargets.has(e.name) || !hasUnboundedText) out.add(e.name);
	}
	return out;
}

/**
 * `store/index.ts` — `createStore({ entities, collections, fields, lookups })`
 * over the full set, keyed by plural. Imports each entity's hooks + collection +
 * generated FieldMeta, and wires the lookups engine. The `fields` + `lookups`
 * keys are what bind `store.<entity>.useData()` (frontend-patterns composes
 * useList + meta=fields[plural] + the hydrated lookups). `export type AppStore =
 * typeof store`.
 */
export function buildStoreIndexFile(ctx: FrontendEmitContext): string {
	const entities = sortEntities(ctx.entities);

	const hookImports = entities
		.map((e) => `import { ${e.camelName}Hooks } from '../entities/${e.name}';`)
		.join('\n');
	const collectionImports = entities
		.map((e) => `import { ${e.camelName}Collection } from '../collections/${e.name}';`)
		.join('\n');
	// Generated FieldMeta per entity (`<camel>Fields` from fields/<entity>).
	// Registered under the SAME plural key as entities/collections so
	// `store.<entity>.useData()` resolves meta = fields[plural].
	const fieldsImports = entities
		.map((e) => `import { ${e.camelName}Fields } from '../fields/${e.name}';`)
		.join('\n');

	const entityEntries = entities
		.map((e) => `\t\t${e.plural}: ${e.camelName}Hooks,`)
		.join('\n');
	const collectionEntries = entities
		.map((e) => `\t\t${e.plural}: ${e.camelName}Collection,`)
		.join('\n');
	const fieldsEntries = entities
		.map((e) => `\t\t${e.plural}: ${e.camelName}Fields,`)
		.join('\n');

	const body = `import { createStore } from '@pattern-stack/frontend-patterns';

${hookImports}

${collectionImports}

${fieldsImports}

import { createLookups } from './lookups';

/**
 * The application store — unified access to every entity.
 *
 * Entities, collections, and field metadata are keyed by their plural name:
 *   store.${entities[0]?.plural ?? 'things'}.useData()   // useList + fields[plural] meta + hydrated lookups
 *   store.${entities[0]?.plural ?? 'things'}.useList()
 *   store.resolve.<entity>(id)
 *   store.lookups.current
 *
 * \`fields\` carries the generated FieldMeta (\`fields/<entity>\` → \`<camel>Fields\`);
 * \`lookups\` is the generated lookups engine (\`{ hydrate(): Promise<EntityLookups>;
 * current }\`) — hydrated once so off-page FK resolution stays correct under
 * pagination-by-default. Both bind \`store.<entity>.useData()\`.
 */
export const store = createStore({
\tentities: {
${entityEntries}
\t},
\tcollections: {
${collectionEntries}
\t},
\tfields: {
${fieldsEntries}
\t},
\tlookups: createLookups(),
});

/** Store type for the \`useStore\` hook. */
export type AppStore = typeof store;
`;
	return withBanner(SOURCE_DESC_SET, body);
}

/**
 * `store/resolvers.ts` — self-contained FK resolvers + typed `<Class>Refs`
 * hydration helpers. Each entity gets an `(id) => <Class> | undefined` resolver
 * backed by its collection's `state.get`; entities with resolvable belongs_to
 * relationships additionally get a `<Class>Refs` interface + `resolve<Class>Refs`
 * hydrator. Self-referential FKs (target === self) do not re-import the entity.
 */
export function buildResolversFile(ctx: FrontendEmitContext): string {
	const entities = sortEntities(ctx.entities);
	// Only lookup-target / light entities are full-fetched (LANDMINE-1 guard); the
	// rest fall back to collection state, so they need no `api` import here.
	const fullFetch = lookupFullFetchNames(ctx);
	const fetched = entities.filter((e) => fullFetch.has(e.name));

	// One collection + one type import per entity. FK targets are always in the
	// same registry set, so a self-referential FK never produces a second import.
	// The api import backs the full-fetch escape hatch (LANDMINE 1) — emitted only
	// for the entities actually full-fetched below.
	const collectionImports = entities
		.map((e) => `import { ${e.camelName}Collection } from '../collections/${e.name}';`)
		.join('\n');
	const apiImports = fetched
		.map((e) => `import { ${e.camelName}Api } from '../api/${e.name}';`)
		.join('\n');
	const typeImports = entities
		.map((e) => `import type { ${e.className} } from '${ctx.config.dbEntitiesImport}/${e.name}';`)
		.join('\n');

	const resolverIface = entities
		.map(
			(e) =>
				`\t${e.camelName}: (id: string | null | undefined) => ${e.className} | undefined;`,
		)
		.join('\n');

	// FK resolve = collection state (O(1), covers the current page + optimistic
	// mutations) WITH a fallback to the full-fetch hydration cache. Under
	// pagination-by-default the collection holds only the current page, so an FK
	// pointing at a row on ANOTHER page would resolve to undefined without the
	// cache (LANDMINE 1). Call `hydrateResolverCache()` once on mount to populate it.
	const resolverImpls = entities
		.map(
			(e) => `\t\t${e.camelName}: (id) => {
\t\t\tif (!id) return undefined;
\t\t\treturn (${e.camelName}Collection.state.get(id) ??
\t\t\t\thydrationCache.${e.camelName}.get(id)) as ${e.className} | undefined;
\t\t},`,
		)
		.join('\n');

	// Module-level full-fetch cache (LANDMINE 1 escape hatch): id → entity over
	// the COMPLETE set, populated by `hydrateResolverCache()` via each entity's
	// `api.listAll()`. Resolvers read it on a collection-state miss so off-page
	// FK resolution returns the right entity.
	const hydrationCacheFields = entities
		.map((e) => `\t${e.camelName}: new Map<string, ${e.className}>(),`)
		.join('\n');
	// Full-fetch only lookup-target / light entities. Heavy non-targets (e.g. a
	// 21k-row emails table with bodyHtml) keep their empty cache map and resolve
	// from collection state — nothing resolves them by id, so off-page coverage is
	// never needed. This is the LANDMINE-1 OOM guard (see lookupFullFetchNames).
	const hydrationCalls = fetched
		.map(
			(e) => `\t\t${e.camelName}Api.listAll().then((rows) => {
\t\t\thydrationCache.${e.camelName} = new Map(rows.map((r) => [r.id as string, r]));
\t\t}),`,
		)
		.join('\n');

	// WithResolved helpers — one block per entity with resolvable belongs_to.
	const refBlocks: string[] = [];
	for (const e of entities) {
		const rels = resolvableRels(e, ctx);
		if (rels.length === 0) continue;

		const refFields = rels
			.map(
				(r) =>
					`\t${r.propertyName}: ${r.target.className} | undefined;`,
			)
			.join('\n');
		const hydrateFields = rels
			.map(
				(r) =>
					`\t\t${r.propertyName}: resolvers.${r.target.camelName}(entity.${r.fieldNameCamel}),`,
			)
			.join('\n');

		refBlocks.push(`/** Resolved FK references for ${e.className}. */
export interface ${e.className}Refs {
${refFields}
}

/** Hydrate a ${e.className} with its resolved FK references. */
export function resolve${e.className}Refs(
\tentity: ${e.className},
\tresolvers: Resolvers,
): ${e.className} & ${e.className}Refs {
\treturn {
\t\t...entity,
${hydrateFields}
\t};
}`);
	}

	const refsSection =
		refBlocks.length > 0
			? `\n// ${'='.repeat(73)}\n// WithResolved helpers — hydrate entities with resolved FKs\n// ${'='.repeat(73)}\n\n${refBlocks.join('\n\n')}\n`
			: '';

	const body = `${collectionImports}
${apiImports}
${typeImports}

/**
 * Full-fetch hydration cache (LANDMINE 1 escape hatch for pagination-by-default).
 *
 * The backing collections hold only the CURRENT PAGE once lists paginate, so an
 * FK pointing at a row on another page resolves to undefined against collection
 * state alone. \`hydrateResolverCache()\` fetches the COMPLETE set per entity (via
 * \`api.listAll()\`, which pages through the envelope) into these id→entity maps;
 * resolvers fall back to them on a collection-state miss. Call it once on mount.
 */
const hydrationCache = {
${hydrationCacheFields}
};

/**
 * Populate the {@link hydrationCache} from the full set of every entity. Await
 * (or fire-and-forget) once at app start so off-page FK resolution is correct.
 * Idempotent — re-running refreshes every cache map.
 */
export async function hydrateResolverCache(): Promise<void> {
\tawait Promise.all([
${hydrationCalls}
\t]);
}

/**
 * FK resolvers — resolve a foreign-key id to the full entity object via the
 * backing collection's local state (\`O(1)\` \`Map.get\`), falling back to the
 * full-fetch hydration cache for ids not on the current page.
 *
 * Usage:
 *   const ${entities[0]?.camelName ?? 'thing'} = resolvers.${entities[0]?.camelName ?? 'thing'}(other.${entities[0]?.camelName ?? 'thing'}Id);
 */
export interface Resolvers {
${resolverIface}
}

/** Build the resolver table over the generated collections + hydration cache. */
export function createResolvers(): Resolvers {
\treturn {
${resolverImpls}
\t};
}
${refsSection}`;
	return withBanner(SOURCE_DESC_SET, body);
}

/**
 * `store/lookups.ts` — self-contained lookup maps (entity id → entity) built
 * from current collection state, with a small caching factory. Keyed by plural.
 */
export function buildLookupsFile(ctx: FrontendEmitContext): string {
	const entities = sortEntities(ctx.entities);

	// Only lookup-target / light entities are full-fetched (LANDMINE-1 guard); the
	// rest fall back to collection state, so they need no `api` import here.
	const fullFetch = lookupFullFetchNames(ctx);
	const fetched = entities.filter((e) => fullFetch.has(e.name));

	const collectionImports = entities
		.map((e) => `import { ${e.camelName}Collection } from '../collections/${e.name}';`)
		.join('\n');
	const apiImports = fetched
		.map((e) => `import { ${e.camelName}Api } from '../api/${e.name}';`)
		.join('\n');
	const typeImports = entities
		.map((e) => `import type { ${e.className} } from '${ctx.config.dbEntitiesImport}/${e.name}';`)
		.join('\n');

	const lookupIface = entities
		.map((e) => `\t${e.plural}: Map<string, ${e.className}>;`)
		.join('\n');

	// One id→entity map for an entity, built from current collection state.
	const collectionStateMap = (e: EntityRegistryEntry): string => `\t\t${e.plural}: new Map(
\t\t\tArray.from(${e.camelName}Collection.state.values()).map((item) => [
\t\t\t\t(item as ${e.className}).id as string,
\t\t\t\titem as ${e.className},
\t\t\t]),
\t\t),`;

	const lookupBuild = entities.map(collectionStateMap).join('\n');

	// Full-fetch variant (LANDMINE 1): build lookup-target / light entities from the
	// COMPLETE set via `api.listAll()` (covers off-page rows under pagination-by-
	// default); heavy non-target entities (e.g. a 21k-row emails table × bodyHtml)
	// are seeded from current collection state instead — full-fetching them pulled
	// hundreds of MB into the renderer and OOM-killed it. See lookupFullFetchNames.
	const lookupBuildAsyncDecls = fetched
		.map((e) => `\t\t${e.camelName}Api.listAll(),`)
		.join('\n');
	const fetchedIndex = new Map(fetched.map((e, i) => [e.name, i]));
	const lookupBuildAsyncFields = entities
		.map((e) => {
			const i = fetchedIndex.get(e.name);
			return i === undefined
				? collectionStateMap(e)
				: `\t\t${e.plural}: new Map(rows[${i}].map((r) => [r.id as string, r as ${e.className}])),`;
		})
		.join('\n');
	// Degenerate set (no full-fetch target): keep the fn valid + await-clean.
	const lookupBuildAsyncBody =
		fetched.length > 0
			? `\tconst rows = await Promise.all([\n${lookupBuildAsyncDecls}\n\t]);\n\treturn {\n${lookupBuildAsyncFields}\n\t};`
			: `\tawait Promise.resolve();\n\treturn {\n${lookupBuildAsyncFields}\n\t};`;

	const body = `${collectionImports}
${apiImports}
${typeImports}

/** All entity lookup maps, keyed by plural entity name (id → entity). */
export interface EntityLookups {
${lookupIface}
}

/** Build fresh lookup maps from current collection state (current page only). */
export function buildLookups(): EntityLookups {
\treturn {
${lookupBuild}
\t};
}

/**
 * Build lookup maps over the COMPLETE set (LANDMINE 1 escape hatch). Pages
 * through every entity's list via \`api.listAll()\` so off-page rows are present.
 * Prefer this over {@link buildLookups} whenever a lookup must resolve ids that
 * may not be on the current page.
 */
export async function buildLookupsAsync(): Promise<EntityLookups> {
${lookupBuildAsyncBody}
}

/**
 * Caching lookup factory: \`build()\` (re)computes from collection state,
 * \`hydrate()\` (re)computes from the full-fetch escape hatch, \`current\` reads,
 * \`clear()\` resets.
 */
export function createLookups() {
\tlet cache: EntityLookups | null = null;
\treturn {
\t\tbuild: (): EntityLookups => {
\t\t\tcache = buildLookups();
\t\t\treturn cache;
\t\t},
\t\thydrate: async (): Promise<EntityLookups> => {
\t\t\tcache = await buildLookupsAsync();
\t\t\treturn cache;
\t\t},
\t\tget current(): EntityLookups | null {
\t\t\treturn cache;
\t\t},
\t\tclear: (): void => {
\t\t\tcache = null;
\t\t},
\t};
}
`;
	return withBanner(SOURCE_DESC_SET, body);
}

/**
 * `store/module-index.ts` — the store module barrel the root `index.ts` imports
 * (mirrors pts root `index.ts.j2`'s `./store/module-index.js`). Re-exports the
 * store, the resolver factory + `Resolvers` type, the lookup factory + types,
 * and each entity's `<Class>Refs` hydrator (entities with resolvable FKs).
 */
export function buildStoreModuleIndexFile(ctx: FrontendEmitContext): string {
	const entities = sortEntities(ctx.entities);

	const lines = [
		"export { store, type AppStore } from './index';",
		"export { createResolvers, hydrateResolverCache, type Resolvers } from './resolvers';",
		"export { buildLookups, buildLookupsAsync, createLookups, type EntityLookups } from './lookups';",
	];

	const refExports = entities
		.filter((e) => resolvableRels(e, ctx).length > 0)
		.map(
			(e) =>
				`export { resolve${e.className}Refs, type ${e.className}Refs } from './resolvers';`,
		);
	if (refExports.length > 0) {
		lines.push('', ...refExports);
	}

	return withBanner(SOURCE_DESC_SET, `${lines.join('\n')}\n`);
}

/**
 * Emit the `store/` tree (`index.ts`, `resolvers.ts`, `lookups.ts`,
 * `module-index.ts`) into `<outDir>/store`. Returns written paths.
 */
export function emitStore(ctx: FrontendEmitContext, outDir: string): string[] {
	const storeDir = join(outDir, 'store');
	const written: string[] = [];

	const files: [string, string][] = [
		['index.ts', buildStoreIndexFile(ctx)],
		['resolvers.ts', buildResolversFile(ctx)],
		['lookups.ts', buildLookupsFile(ctx)],
		['module-index.ts', buildStoreModuleIndexFile(ctx)],
	];

	for (const [fileName, content] of files) {
		const filePath = join(storeDir, fileName);
		writeFile(filePath, content);
		written.push(filePath);
	}

	return written;
}
