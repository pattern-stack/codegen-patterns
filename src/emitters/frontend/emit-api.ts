/**
 * Frontend emitter — REST api client (ADR-038, FE-2).
 *
 * Emits `api/client.ts` (base fetch transport: baseURL + auth header), a
 * per-entity `api/<entity>.ts` (list/get/create/update/delete against the
 * generated NestJS controller routes), and `api/index.ts` (barrel).
 *
 * The api client owns transport; collections in `api` sync mode call into it
 * rather than inlining a fetch.
 */

import { join } from 'node:path';
import type { EntityRegistryEntry, FrontendEmitContext } from './types';
import { sortEntities } from './types';
import { withBanner, writeFile } from './emit-utils';

const SOURCE_DESC_SET = 'the entity set';

/** Update verb: clean → PUT, clean-lite-ps → PATCH. */
function updateVerb(architecture: 'clean' | 'clean-lite-ps'): 'PUT' | 'PATCH' {
	return architecture === 'clean-lite-ps' ? 'PATCH' : 'PUT';
}

/**
 * `api/client.ts` — the base fetch transport. baseURL resolves to `API_BASE_URL`
 * (imported) when `apiBaseUrlImport` is set, else the literal `apiUrl`. When an
 * auth function is configured, every request sends an `Authorization` header.
 */
export function buildClientFile(ctx: FrontendEmitContext): string {
	const { config } = ctx;
	const importLines: string[] = [];

	if (config.apiBaseUrlImport) {
		importLines.push(`import { API_BASE_URL } from '${config.apiBaseUrlImport}';`);
	}
	if (config.authFunction) {
		importLines.push(`import { ${config.authFunction} } from '${config.authImport}';`);
	}

	const baseUrlConst = config.apiBaseUrlImport
		? 'const BASE_URL = API_BASE_URL;'
		: `const BASE_URL = '${config.apiUrl}';`;

	const authHeaderBlock = config.authFunction
		? `\tconst headers: Record<string, string> = {
\t\t'Content-Type': 'application/json',
\t\tAuthorization: ${config.authFunction}(),
\t};`
		: `\tconst headers: Record<string, string> = {
\t\t'Content-Type': 'application/json',
\t};`;

	const imports = importLines.length > 0 ? `${importLines.join('\n')}\n\n` : '';

	const body = `${imports}${baseUrlConst}

/** Hard upper bound on a single list fetch — mirrors the backend pageSize clamp. */
export const MAX_PAGE_SIZE = 200;

/**
 * Pagination envelope returned by every \`GET /<entities>\` (pagination-by-default).
 * Mirrors the backend \`Page<T>\` runtime contract
 * (\`@pattern-stack/codegen/runtime/http/pagination\`); duplicated here so the
 * generated frontend data layer carries no backend import. \`nextCursor\` is
 * contract-stable (the backend emits it from day one) — the offset engine
 * ignores it on request for now.
 */
export interface Page<T> {
\titems: T[];
\tpage: number;
\tpageCount: number;
\ttotal: number;
\tpageSize: number;
\tnextCursor: string | null;
}

/**
 * Request query for a list endpoint: page-based pagination + default sort, plus
 * arbitrary where-filters (passed through to the backend querystring). All keys
 * optional — the unfiltered first page is the default.
 */
export interface ListQuery {
\tpage?: number;
\tcursor?: string;
\tpageSize?: number;
\tsort_by?: string;
\tsort_order?: 'asc' | 'desc';
\t[key: string]: string | number | boolean | null | undefined;
}

/**
 * Serialize a {@link ListQuery} into a querystring (leading \`?\`), skipping
 * undefined/null values. Returns \`''\` for an empty/absent query so an
 * unfiltered \`list()\` hits the bare route.
 */
export function toListQueryString(query?: ListQuery): string {
\tif (!query) return '';
\tconst params = new URLSearchParams();
\tfor (const [key, value] of Object.entries(query)) {
\t\tif (value === undefined || value === null) continue;
\t\tparams.set(key, String(value));
\t}
\tconst qs = params.toString();
\treturn qs ? \`?\${qs}\` : '';
}

/**
 * Base REST transport for \`api\` sync-mode collections and entity api clients.
 * Throws on non-2xx; returns parsed JSON, or \`undefined\` for 204 No Content.
 */
export async function request<T>(
\tmethod: string,
\tpath: string,
\tbody?: unknown,
): Promise<T> {
${authHeaderBlock}

\tconst res = await fetch(\`\${BASE_URL}\${path}\`, {
\t\tmethod,
\t\theaders,
\t\tbody: body === undefined ? undefined : JSON.stringify(body),
\t});

\tif (!res.ok) {
\t\tthrow new Error(\`\${method} \${path} → \${res.status} \${res.statusText}\`);
\t}

\tif (res.status === 204) {
\t\treturn undefined as T;
\t}

\treturn res.json() as Promise<T>;
}
`;
	return withBanner(SOURCE_DESC_SET, body);
}

/**
 * `api/<entity>.ts` — per-entity REST methods over the generated controller
 * routes. The entity type is imported plain (`<Class>`) from `dbEntities`
 * (typeNaming knob is dead; packages/db exports plain names — see FE-2 report).
 */
export function buildEntityApiFile(
	entity: EntityRegistryEntry,
	ctx: FrontendEmitContext,
): string {
	const { config } = ctx;
	const { camelName, plural, className, name } = entity;
	const verb = updateVerb(config.architecture);

	const body = `import { MAX_PAGE_SIZE, type ListQuery, type Page, request, toListQueryString } from './client';
import type { ${className} } from '${config.dbEntitiesImport}/${name}';

export const ${camelName}Api = {
\t/**
\t * Fetch one page of ${plural} (pagination-by-default). Threads page/cursor/
\t * pageSize/sort + arbitrary where-filters into the querystring; returns the
\t * \`Page<${className}>\` envelope. Call with no args for the unfiltered first page.
\t */
\tlist: (query?: ListQuery): Promise<Page<${className}>> =>
\t\trequest<Page<${className}>>('GET', \`/${plural}\${toListQueryString(query)}\`),

\t/**
\t * Full-fetch escape hatch (LANDMINE 1): every ${className} across all pages as a
\t * flat array. Pages through the envelope until exhausted so off-page FK
\t * resolution (resolvers/lookups) stays correct under pagination-by-default —
\t * the backing collection only holds the current page, so FK targets that live
\t * on another page would otherwise resolve to undefined. Used to hydrate the
\t * store's resolvers/lookups; NOT for rendering a paged table.
\t */
\tlistAll: async (query?: Omit<ListQuery, 'page' | 'pageSize' | 'cursor'>): Promise<${className}[]> => {
\t\tconst all: ${className}[] = [];
\t\tlet page = 1;
\t\tlet pageCount = 1;
\t\tdo {
\t\t\tconst result = await request<Page<${className}>>(
\t\t\t\t'GET',
\t\t\t\t\`/${plural}\${toListQueryString({ ...query, page, pageSize: MAX_PAGE_SIZE })}\`,
\t\t\t);
\t\t\tall.push(...result.items);
\t\t\tpageCount = result.pageCount;
\t\t\tpage += 1;
\t\t} while (page <= pageCount);
\t\treturn all;
\t},

\tget: (id: string): Promise<${className}> =>
\t\trequest<${className}>('GET', \`/${plural}/\${id}\`),

\tcreate: (data: Partial<${className}>): Promise<${className}> =>
\t\trequest<${className}>('POST', '/${plural}', data),

\tupdate: (id: string, data: Partial<${className}>): Promise<${className}> =>
\t\trequest<${className}>('${verb}', \`/${plural}/\${id}\`, data),

\tdelete: (id: string): Promise<void> =>
\t\trequest<void>('DELETE', \`/${plural}/\${id}\`),
};
`;
	return withBanner(`entities/${name}.yaml`, body);
}

/** `api/index.ts` — re-export the client plus each entity api, sorted. */
export function buildApiIndexFile(ctx: FrontendEmitContext): string {
	const entities = sortEntities(ctx.entities);
	const lines = [
		"export * from './client';",
		...entities.map((e) => `export * from './${e.name}';`),
	];
	return withBanner(SOURCE_DESC_SET, `${lines.join('\n')}\n`);
}

/**
 * Emit `api/client.ts`, `api/<entity>.ts` (sorted), and `api/index.ts` into
 * `<outDir>/api`. Returns written paths.
 */
export function emitApi(ctx: FrontendEmitContext, outDir: string): string[] {
	const apiDir = join(outDir, 'api');
	const entities = sortEntities(ctx.entities);
	const written: string[] = [];

	const clientPath = join(apiDir, 'client.ts');
	writeFile(clientPath, buildClientFile(ctx));
	written.push(clientPath);

	for (const entity of entities) {
		const entityPath = join(apiDir, `${entity.name}.ts`);
		writeFile(entityPath, buildEntityApiFile(entity, ctx));
		written.push(entityPath);
	}

	const indexPath = join(apiDir, 'index.ts');
	writeFile(indexPath, buildApiIndexFile(ctx));
	written.push(indexPath);

	return written;
}
