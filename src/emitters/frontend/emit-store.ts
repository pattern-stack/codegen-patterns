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
 * `store/index.ts` — `createStore({ entities, collections })` over the full set,
 * keyed by plural. Imports each entity's hooks + collection. `export type
 * AppStore = typeof store`.
 */
export function buildStoreIndexFile(ctx: FrontendEmitContext): string {
	const entities = sortEntities(ctx.entities);

	const hookImports = entities
		.map((e) => `import { ${e.camelName}Hooks } from '../entities/${e.name}';`)
		.join('\n');
	const collectionImports = entities
		.map((e) => `import { ${e.camelName}Collection } from '../collections/${e.name}';`)
		.join('\n');

	const entityEntries = entities
		.map((e) => `\t\t${e.plural}: ${e.camelName}Hooks,`)
		.join('\n');
	const collectionEntries = entities
		.map((e) => `\t\t${e.plural}: ${e.camelName}Collection,`)
		.join('\n');

	const body = `import { createStore } from '@pattern-stack/frontend-patterns';

${hookImports}

${collectionImports}

/**
 * The application store — unified access to every entity.
 *
 * Entities and collections are keyed by their plural name:
 *   store.${entities[0]?.plural ?? 'things'}.useList()
 *   store.resolve.<entity>(id)
 *   store.lookups.build()
 */
export const store = createStore({
\tentities: {
${entityEntries}
\t},
\tcollections: {
${collectionEntries}
\t},
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

	// One collection + one type import per entity. FK targets are always in the
	// same registry set, so a self-referential FK never produces a second import.
	const collectionImports = entities
		.map((e) => `import { ${e.camelName}Collection } from '../collections/${e.name}';`)
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

	const resolverImpls = entities
		.map(
			(e) => `\t\t${e.camelName}: (id) => {
\t\t\tif (!id) return undefined;
\t\t\treturn ${e.camelName}Collection.state.get(id) as ${e.className} | undefined;
\t\t},`,
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
${typeImports}

/**
 * FK resolvers — resolve a foreign-key id to the full entity object via the
 * backing collection's local state (\`O(1)\` \`Map.get\`).
 *
 * Usage:
 *   const ${entities[0]?.camelName ?? 'thing'} = resolvers.${entities[0]?.camelName ?? 'thing'}(other.${entities[0]?.camelName ?? 'thing'}Id);
 */
export interface Resolvers {
${resolverIface}
}

/** Build the resolver table over the generated collections. */
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

	const collectionImports = entities
		.map((e) => `import { ${e.camelName}Collection } from '../collections/${e.name}';`)
		.join('\n');
	const typeImports = entities
		.map((e) => `import type { ${e.className} } from '${ctx.config.dbEntitiesImport}/${e.name}';`)
		.join('\n');

	const lookupIface = entities
		.map((e) => `\t${e.plural}: Map<string, ${e.className}>;`)
		.join('\n');

	const lookupBuild = entities
		.map(
			(e) => `\t\t${e.plural}: new Map(
\t\t\tArray.from(${e.camelName}Collection.state.values()).map((item) => [
\t\t\t\t(item as ${e.className}).id as string,
\t\t\t\titem as ${e.className},
\t\t\t]),
\t\t),`,
		)
		.join('\n');

	const body = `${collectionImports}
${typeImports}

/** All entity lookup maps, keyed by plural entity name (id → entity). */
export interface EntityLookups {
${lookupIface}
}

/** Build fresh lookup maps from current collection state. */
export function buildLookups(): EntityLookups {
\treturn {
${lookupBuild}
\t};
}

/** Caching lookup factory: \`build()\` (re)computes, \`current\` reads, \`clear()\` resets. */
export function createLookups() {
\tlet cache: EntityLookups | null = null;
\treturn {
\t\tbuild: (): EntityLookups => {
\t\t\tcache = buildLookups();
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
		"export { createResolvers, type Resolvers } from './resolvers';",
		"export { buildLookups, createLookups, type EntityLookups } from './lookups';",
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
