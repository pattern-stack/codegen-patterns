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
import type { EntityRegistryEntry, FrontendEmitContext } from './types';
import { resolveSyncMode, sortEntities } from './types';
import { withBanner, writeFile } from './emit-utils';

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
	const { camelName, plural, name } = entity;

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
	const { camelName, plural, name } = entity;

	const imports = [
		"import { queryCollectionOptions } from '@tanstack/query-db-collection';",
		"import { createCollection } from '@tanstack/react-db';",
		"import { queryClient } from '../query-client';",
		`import { ${camelName}Api } from '../api/${name}';`,
		`import { ${camelName}Schema } from '${config.dbEntitiesImport}/${name}';`,
	];

	const body = `${imports.join('\n')}

export const ${camelName}Collection = createCollection(
\tqueryCollectionOptions({
\t\tid: '${plural}',
\t\tqueryKey: ['${plural}'],
\t\tqueryClient,
\t\tqueryFn: () => ${camelName}Api.list(),
\t\tgetKey: (item) => item.id,
\t\tschema: ${camelName}Schema,
\t}),
);
`;
	return withBanner(`entities/${name}.yaml`, body);
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

/** `collections/index.ts` — `export * from './<name>'` per entity, sorted. */
export function buildCollectionsIndexFile(ctx: FrontendEmitContext): string {
	const entities = sortEntities(ctx.entities);
	const lines = entities.map((e) => `export * from './${e.name}';`);
	return withBanner(SOURCE_DESC_SET, `${lines.join('\n')}\n`);
}

/**
 * Emit `collections/<entity>.ts` (sorted) and `collections/index.ts` into
 * `<outDir>/collections`. Returns written paths.
 */
export function emitCollections(ctx: FrontendEmitContext, outDir: string): string[] {
	const collectionsDir = join(outDir, 'collections');
	const entities = sortEntities(ctx.entities);
	const written: string[] = [];

	for (const entity of entities) {
		const filePath = join(collectionsDir, `${entity.name}.ts`);
		writeFile(filePath, buildCollectionFile(entity, ctx));
		written.push(filePath);
	}

	const indexPath = join(collectionsDir, 'index.ts');
	writeFile(indexPath, buildCollectionsIndexFile(ctx));
	written.push(indexPath);

	return written;
}
