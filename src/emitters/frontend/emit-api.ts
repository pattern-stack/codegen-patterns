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

	const body = `import { request } from './client';
import type { ${className} } from '${config.dbEntitiesImport}/${name}';

export const ${camelName}Api = {
\tlist: (): Promise<${className}[]> => request<${className}[]>('GET', '/${plural}'),

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
