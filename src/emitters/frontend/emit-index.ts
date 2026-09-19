/**
 * Frontend emitter — root barrel (ADR-038, FE-3).
 *
 * Ports pts `index.ts.j2`: section-commented `export *` of every sub-barrel
 * (config, query-client, api, collections, entities, fields) plus the store
 * module barrel. Prepends the version-pairing block from `deps.ts` as a comment
 * table so package drift is visible in the consumer
 * (docs/specs/2026-06-04-frontend-pipeline-rebuild.md → "Version pairing").
 *
 * The exported name families are disjoint (collections → \`<camel>Collection\`,
 * api → \`<camel>Api\`, entities → hooks, fields → \`<camel>Fields\`/Metadata,
 * store → \`store\`/resolvers/lookups), so a flat \`export *\` of each barrel
 * never collides.
 */

import { join } from 'node:path';
import type { FrontendEmitContext } from './types';
import { sortEntities } from './types';
import { withBanner, writeFile } from './emit-utils';
import { FRONTEND_DEP_OVERRIDES, FRONTEND_EMITTED_DEPS } from './deps';

const SOURCE_DESC_SET = 'the entity set';

/**
 * Render the version-pairing block as an aligned comment table. The emitted
 * imports target these package ranges; the consumer's frontend `package.json`
 * must install them (see `deps.ts`).
 *
 * The exact pins are what keep one `@tanstack/db` (and so one type identity)
 * in the tree; the `overrides` stanza is belt-and-braces on top of them (FE-0,
 * #620 — see `deps.ts`). `project init` merges both into the frontend
 * `package.json`; they are restated here because this comment is the only
 * place the contract is visible from inside a consumer's tree.
 */
export function buildVersionPairingComment(): string {
	const entries = Object.entries(FRONTEND_EMITTED_DEPS);
	const nameWidth = Math.max(...entries.map(([name]) => name.length));
	const rows = entries
		.map(([name, range]) => ` *   ${name.padEnd(nameWidth)}  ${range}`)
		.join('\n');
	const overrideRows = Object.entries(FRONTEND_DEP_OVERRIDES)
		.map(([name, spec]) => ` *   "${name}": "${spec}"`)
		.join('\n');
	return ` * Version pairing — the emitted imports require these package ranges in the
 * consumer's frontend package.json:
 *
${rows}
 *
 * The four @tanstack/*db* pins move together or not at all: any other version
 * splits @tanstack/db into several copies and the emitted collections stop
 * type-checking — see docs/specs/FE-0.md. This "overrides" entry (npm/bun;
 * "pnpm.overrides" for pnpm, "resolutions" for yarn) keeps a single copy even
 * if a transitive range ever disagrees with the pin:
 *
${overrideRows}`;
}

/**
 * `index.ts` — the root barrel. Section comments + `export *` of each sub-barrel,
 * prefixed by the version-pairing comment.
 */
export function buildRootIndexFile(ctx: FrontendEmitContext): string {
	const entities = sortEntities(ctx.entities);
	const entityList = entities
		.map((e) => ` * - ${e.className}`)
		.join('\n');

	const body = `/**
 * Generated frontend data layer.
 *
 * Entities:
${entityList || ' * (none)'}
 *
${buildVersionPairingComment()}
 */

// Per-entity sync configuration + runtime overrides
export * from './config';

// Shared TanStack QueryClient
export * from './query-client';

// REST api client
export * from './api/index';

// TanStack DB collections (per-entity sync mode)
export * from './collections/index';

// Entity hooks (createEntityHooks wiring)
export * from './entities/index';

// Field metadata (DataGrid / forms / admin)
export * from './fields/index';
${
	ctx.providers && ctx.providers.length > 0
		? `
// Providers catalog (definitions/providers + frontend.catalog.categories)
export * from './providers';
`
		: ''
}
// Unified store (entities + collections + resolvers + lookups)
export * from './store/module-index';
`;
	return withBanner(SOURCE_DESC_SET, body);
}

/** Emit the root `index.ts` into `<outDir>`. Returns the written path. */
export function emitIndex(ctx: FrontendEmitContext, outDir: string): string[] {
	const indexPath = join(outDir, 'index.ts');
	writeFile(indexPath, buildRootIndexFile(ctx));
	return [indexPath];
}
