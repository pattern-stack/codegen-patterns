/**
 * Frontend emitter — per-entity collections (ADR-038, FE-2).
 *
 * Replaces `templates/entity/new/frontend/collections/*`. Each entity emits one
 * `collections/<name>.ts` branched on its resolved sync mode:
 *   - electric → electricCollectionOptions (real-time shape sync)
 *   - api      → queryCollectionOptions backed by the generated REST api client
 *
 * Electric branch ports the deleted `collection.ejs.t` semantics
 * (shapeUrl / useTableParam / columnMapper / columnMapperNeedsCall / parsers /
 * auth), with the `typeof window !== 'undefined'` SSR guard adopted uniformly
 * (it was inconsistent across the templates). The Zod schema is a direct named
 * import from `${dbEntities}/<name>` — `schemaPrefix` is dead.
 */

import { join } from 'node:path';
import { emittedStem } from '../../config/file-naming.js';
import type { EntityRegistryEntry, FrontendEmitContext } from './types';
import { resolveSyncMode, sortEntities } from './types';
import { withBanner, writeFile } from './emit-utils';
import type { ClientGraph, JunctionCollectionEntry } from './graph-model';

const SOURCE_DESC_SET = 'the entity set';

/**
 * The shape/list base URL expression. With `apiBaseUrlImport`, the literal
 * `${API_BASE_URL}/<plural>`; otherwise the configured base (`shapeUrl` for
 * electric, `apiUrl` for api) joined to the plural.
 */
function baseUrlExpr(base: string, plural: string, apiBaseUrlImport: string | null): string {
	return apiBaseUrlImport ? `\`\${API_BASE_URL}/${plural}\`` : `\`${base}/${plural}\``;
}

/** SSR-safe origin: `''` on the server, `window.location.origin` in the browser. */
const SSR_ORIGIN_EXPR = "typeof window !== 'undefined' ? window.location.origin : ''";

function buildElectricCollection(
	entity: EntityRegistryEntry,
	ctx: FrontendEmitContext,
): string {
	const { config } = ctx;
	const { camelName, plural, name, fileStem } = entity;

	const imports: string[] = [
		"import { electricCollectionOptions } from '@tanstack/electric-db-collection';",
		"import { createCollection } from '@tanstack/react-db';",
	];
	if (config.columnMapper) {
		imports.push(`import { ${config.columnMapper} } from '@electric-sql/client';`);
	}
	if (config.authFunction) {
		imports.push(`import { ${config.authFunction} } from '${config.authImport}';`);
	}
	if (config.apiBaseUrlImport) {
		imports.push(`import { API_BASE_URL } from '${config.apiBaseUrlImport}';`);
	}
	imports.push(`import { ${camelName}Schema } from '${config.dbEntitiesImport}/${name}';`);

	// shapeOptions.url — SSR-guarded URL construction, two forms.
	let urlBlock: string;
	if (config.useTableParam) {
		urlBlock = `\t\t\turl: new URL(
\t\t\t\t'${config.shapeUrl}',
\t\t\t\t${SSR_ORIGIN_EXPR},
\t\t\t).toString(),
\t\t\tparams: {
\t\t\t\ttable: '${plural}',
\t\t\t},`;
	} else {
		const shapeUrl = baseUrlExpr(config.shapeUrl, plural, config.apiBaseUrlImport);
		urlBlock = `\t\t\turl: new URL(
\t\t\t\t${shapeUrl},
\t\t\t\t${SSR_ORIGIN_EXPR},
\t\t\t).toString(),`;
	}

	const headersBlock = config.authFunction
		? `\n\t\t\theaders: {
\t\t\t\tAuthorization: ${config.authFunction}(),
\t\t\t},`
		: '';

	const parserEntries = Object.entries(config.parsers)
		.map(([type, fn]) => `\t\t\t\t${type}: ${fn},`)
		.join('\n');
	const parserBlock = parserEntries
		? `\n\t\t\tparser: {
${parserEntries}
\t\t\t},`
		: `\n\t\t\tparser: {},`;

	let columnMapperBlock = '';
	if (config.columnMapper) {
		const mapperExpr = config.columnMapperNeedsCall
			? `${config.columnMapper}()`
			: config.columnMapper;
		columnMapperBlock = `\n\t\t\tcolumnMapper: ${mapperExpr},`;
	}

	const body = `${imports.join('\n')}

export const ${camelName}Collection = createCollection(
\telectricCollectionOptions({
\t\tid: '${plural}',
\t\tshapeOptions: {
${urlBlock}${headersBlock}${parserBlock}${columnMapperBlock}
\t\t},
\t\tschema: ${camelName}Schema,
\t\tgetKey: (item) => item.id,
\t}),
);
`;
	return withBanner(`entities/${name}.yaml`, body);
}

function buildApiCollection(
	entity: EntityRegistryEntry,
	ctx: FrontendEmitContext,
): string {
	const { config } = ctx;
	const { camelName, plural, name, fileStem } = entity;

	const imports = [
		"import { queryCollectionOptions } from '@tanstack/query-db-collection';",
		"import { createCollection } from '@tanstack/react-db';",
		"import { queryClient } from '../query-client';",
		`import { ${camelName}Api } from '../api/${fileStem}';`,
		`import { ${camelName}Schema } from '${config.dbEntitiesImport}/${name}';`,
	];

	const body = `${imports.join('\n')}

export const ${camelName}Collection = createCollection(
\tqueryCollectionOptions({
\t\tid: '${plural}',
\t\tqueryKey: ['${plural}'],
\t\tqueryClient,
\t\t// pagination-by-default: the list endpoint returns a Page<T> envelope, so
\t\t// unwrap \`.items\` to seed the collection with rows (the first page). The
\t\t// paged table drives later fetches via the sync-layer useList; off-page FK
\t\t// resolution hydrates from the full-fetch escape hatch (store/resolvers.ts).
\t\t// async/await (not \`.then\`) so queryCollectionOptions' overload inference
\t\t// keeps \`getKey\`'s \`item\` typed — the .then() form collapses it to unknown.
\t\tqueryFn: async () => {
\t\t\tconst page = await ${camelName}Api.list();
\t\t\treturn page.items;
\t\t},
\t\tgetKey: (item) => item.id,
\t\tschema: ${camelName}Schema,
\t}),
);
`;
	return withBanner(`entities/${name}.yaml`, body);
}

/**
 * Build `collections/<junction>.ts` — the link rows of a junction (FE-REL §4.2).
 *
 * A junction hop is a join through the LINK rows, so they have to be in the
 * browser like any other collection. Electric only, and deliberately so:
 * `junction new` emits no controller, so junction rows have no REST surface to
 * back a `queryCollectionOptions` branch. `graphJunctions()` returns nothing
 * outside `electric` mode, and a hop through a junction that cannot reach the
 * browser is the cross-mode generation error rather than an import of a file
 * that was never written.
 *
 * Two things differ from an entity collection, both forced by the junction's
 * own shape (`templates/junction/new/entity.ejs.t`):
 *
 *  - **no surrogate `id`.** The table's primary key is the composite of its two
 *    FK columns, so `getKey` is that pair rather than `item.id`.
 *  - **the row type is consumer-owned like every other.** `locations.dbEntities`
 *    names a module the consumer provides (ADR-038); a junction's schema lives
 *    there beside the entities' for the same reason.
 */
export function buildJunctionCollectionFile(
	junction: JunctionCollectionEntry,
	ctx: FrontendEmitContext,
): string {
	const { config } = ctx;
	const { camelName, plural, name } = junction;

	const imports: string[] = [
		"import { electricCollectionOptions } from '@tanstack/electric-db-collection';",
		"import { createCollection } from '@tanstack/react-db';",
	];
	if (config.columnMapper) {
		imports.push(`import { ${config.columnMapper} } from '@electric-sql/client';`);
	}
	if (config.authFunction) {
		imports.push(`import { ${config.authFunction} } from '${config.authImport}';`);
	}
	if (config.apiBaseUrlImport) {
		imports.push(`import { API_BASE_URL } from '${config.apiBaseUrlImport}';`);
	}
	imports.push(`import { ${camelName}Schema } from '${config.dbEntitiesImport}/${name}';`);

	let urlBlock: string;
	if (config.useTableParam) {
		urlBlock = `\t\t\turl: new URL(
\t\t\t\t'${config.shapeUrl}',
\t\t\t\t${SSR_ORIGIN_EXPR},
\t\t\t).toString(),
\t\t\tparams: {
\t\t\t\ttable: '${plural}',
\t\t\t},`;
	} else {
		const shapeUrl = baseUrlExpr(config.shapeUrl, plural, config.apiBaseUrlImport);
		urlBlock = `\t\t\turl: new URL(
\t\t\t\t${shapeUrl},
\t\t\t\t${SSR_ORIGIN_EXPR},
\t\t\t).toString(),`;
	}

	const headersBlock = config.authFunction
		? `\n\t\t\theaders: {
\t\t\t\tAuthorization: ${config.authFunction}(),
\t\t\t},`
		: '';

	const parserEntries = Object.entries(config.parsers)
		.map(([type, fn]) => `\t\t\t\t${type}: ${fn},`)
		.join('\n');
	const parserBlock = parserEntries
		? `\n\t\t\tparser: {
${parserEntries}
\t\t\t},`
		: `\n\t\t\tparser: {},`;

	let columnMapperBlock = '';
	if (config.columnMapper) {
		const mapperExpr = config.columnMapperNeedsCall
			? `${config.columnMapper}()`
			: config.columnMapper;
		columnMapperBlock = `\n\t\t\tcolumnMapper: ${mapperExpr},`;
	}

	const [leftKey, rightKey] = junction.keyColumns;
	const body = `${imports.join('\n')}

export const ${camelName}Collection = createCollection(
\telectricCollectionOptions({
\t\tid: '${plural}',
\t\tshapeOptions: {
${urlBlock}${headersBlock}${parserBlock}${columnMapperBlock}
\t\t},
\t\tschema: ${camelName}Schema,
\t\t// Composite primary key — a junction table carries no surrogate \`id\`.
\t\tgetKey: (item) => \`\${item.${leftKey}}:\${item.${rightKey}}\`,
\t}),
);
`;
	return withBanner(`junctions/${name}.yaml`, body);
}

/**
 * Build `collections/<name>.ts` for a single entity, branched on its resolved
 * sync mode (`entity.sync ?? config.globalSyncMode`).
 */
export function buildCollectionFile(
	entity: EntityRegistryEntry,
	ctx: FrontendEmitContext,
): string {
	const mode = resolveSyncMode(entity, ctx.config);
	return mode === 'api'
		? buildApiCollection(entity, ctx)
		: buildElectricCollection(entity, ctx);
}

/**
 * `collections/index.ts` — `export * from './<stem>'` per entity and per
 * emitted junction, sorted by file name so entities and junctions interleave
 * deterministically. Stems come from the one naming rule (#695/#684).
 */
export function buildCollectionsIndexFile(
	ctx: FrontendEmitContext,
	junctions: JunctionCollectionEntry[] = [],
): string {
	const names = [
		...sortEntities(ctx.entities).map((e) => e.fileStem),
		...junctions.map((j) => emittedStem(j.name)),
	].sort((a, b) => a.localeCompare(b));
	const lines = names.map((n) => `export * from './${n}';`);
	return withBanner(SOURCE_DESC_SET, `${lines.join('\n')}\n`);
}

/**
 * Emit `collections/<entity>.ts` (sorted) and `collections/index.ts` into
 * `<outDir>/collections`. Returns written paths.
 */
export function emitCollections(
	ctx: FrontendEmitContext,
	outDir: string,
	graph: ClientGraph | null = null,
): string[] {
	const collectionsDir = join(outDir, 'collections');
	const entities = sortEntities(ctx.entities);
	const junctions = junctionsToEmit(ctx, graph);
	const written: string[] = [];

	for (const entity of entities) {
		const filePath = join(collectionsDir, `${entity.fileStem}.ts`);
		writeFile(filePath, buildCollectionFile(entity, ctx));
		written.push(filePath);
	}

	for (const junction of junctions) {
		// The file stem must be the one the barrel exports — `emittedStem`, the
		// #695/#684 naming rule — not the raw junction name. A single-word
		// junction spells the same either way; a multi-word one does not, and the
		// barrel's `./opportunity-tag` then pointed at an emitted
		// `opportunity_tag.ts` that TypeScript could not resolve.
		const filePath = join(collectionsDir, `${emittedStem(junction.name)}.ts`);
		writeFile(filePath, buildJunctionCollectionFile(junction, ctx));
		written.push(filePath);
	}

	const indexPath = join(collectionsDir, 'index.ts');
	writeFile(indexPath, buildCollectionsIndexFile(ctx, junctions));
	written.push(indexPath);

	return written;
}

/**
 * The junctions this set emits a collection for. Electric only — see
 * {@link buildJunctionCollectionFile}.
 */
export function junctionsToEmit(
	ctx: FrontendEmitContext,
	graph: ClientGraph | null,
): JunctionCollectionEntry[] {
	if (!graph || ctx.config.globalSyncMode !== 'electric') return [];
	return graph.junctions;
}
