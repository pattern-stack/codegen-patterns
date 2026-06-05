/**
 * Frontend emitter — base files: `query-client.ts` + `config.ts` (ADR-038, FE-2).
 *
 * Ports pts `query_client.ts.j2` (shared QueryClient) and `config.ts.j2`
 * (per-entity sync modes + runtime overrides). `offline` is intentionally absent
 * from the emitted `SyncMode` — deferred per
 * docs/specs/2026-06-04-frontend-pipeline-rebuild.md OQ-6.
 */

import { join } from 'node:path';
import type { FrontendEmitContext } from './types';
import { resolveSyncMode, sortEntities } from './types';
import { withBanner, writeFile } from './emit-utils';

const SOURCE_DESC = 'the entity set';

/**
 * `query-client.ts` — the shared TanStack QueryClient. Ported verbatim from pts
 * `query_client.ts.j2` (staleTime 60s, gcTime 5m, replaceability comment).
 * Entity-independent, so the body is constant.
 */
export function buildQueryClientFile(): string {
	const body = `import { QueryClient } from '@tanstack/react-query';

/**
 * Shared QueryClient for REST-backed (\`api\` sync mode) collections.
 *
 * Replaceable: swap this for your app's own QueryClient if you already create
 * one — every generated collection imports \`queryClient\` from this module.
 */
export const queryClient = new QueryClient({
\tdefaultOptions: {
\t\tqueries: {
\t\t\tstaleTime: 60 * 1000, // 60s
\t\t\tgcTime: 5 * 60 * 1000, // 5m
\t\t},
\t},
});
`;
	return withBanner(SOURCE_DESC, body);
}

/**
 * `config.ts` — per-entity sync modes + runtime override surface. Ported from
 * pts `config.ts.j2`. The `defaultConfig` table is built from each entity's
 * resolved mode; `getSyncMode`/`setEntityConfig` expose runtime reads/overrides.
 */
export function buildConfigFile(ctx: FrontendEmitContext): string {
	const entities = sortEntities(ctx.entities);

	const entityNameUnion =
		entities.length > 0
			? entities.map((e) => `'${e.name}'`).join(' | ')
			: 'string';

	const defaultEntries = entities
		.map((e) => `\t${e.name}: { mode: '${resolveSyncMode(e, ctx.config)}' },`)
		.join('\n');

	const body = `/**
 * Per-entity sync configuration + runtime overrides.
 *
 * \`mode\` selects the collection backing for an entity:
 *   - 'electric' → real-time shape sync (electricCollectionOptions)
 *   - 'api'      → REST via TanStack Query (queryCollectionOptions)
 *
 * The offline mode (Electric + Dexie) is deferred — see
 * docs/specs/2026-06-04-frontend-pipeline-rebuild.md OQ-6.
 */

export type SyncMode = 'api' | 'electric';

export type EntityName = ${entityNameUnion};

export interface EntitySyncConfig {
\tmode: SyncMode;
}

/** Resolved per-entity sync modes (per-entity \`sync:\` over global default). */
export const defaultConfig: Record<EntityName, EntitySyncConfig> = {
${defaultEntries}
};

/** Runtime overrides, layered over \`defaultConfig\`. */
const overrides: Partial<Record<EntityName, EntitySyncConfig>> = {};

/** Resolve an entity's effective sync mode (override wins over default). */
export function getSyncMode(entity: EntityName): SyncMode {
\treturn (overrides[entity] ?? defaultConfig[entity]).mode;
}

/** Override an entity's sync config at runtime. */
export function setEntityConfig(entity: EntityName, config: EntitySyncConfig): void {
\toverrides[entity] = config;
}
`;
	return withBanner(SOURCE_DESC, body);
}

/**
 * Emit the base files into `outDir`. Returns written paths (sorted by emit
 * order: query-client, then config).
 */
export function emitBase(ctx: FrontendEmitContext, outDir: string): string[] {
	const written: string[] = [];

	const queryClientPath = join(outDir, 'query-client.ts');
	writeFile(queryClientPath, buildQueryClientFile());
	written.push(queryClientPath);

	const configPath = join(outDir, 'config.ts');
	writeFile(configPath, buildConfigFile(ctx));
	written.push(configPath);

	return written;
}
