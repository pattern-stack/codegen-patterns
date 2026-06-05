/**
 * Frontend emitter — per-entity hook wiring + entities barrel (ADR-038, FE-3).
 *
 * Ports pts `entity.ts.j2` / `entities_index.ts.j2`. Each entity emits one
 * `entities/<name>.ts` that wires `createEntityHooks` from
 * `@pattern-stack/frontend-patterns` over the entity's collection + api client,
 * plus the destructured per-entity hook re-exports.
 *
 * Adaptations vs pts (recorded in the parent spec):
 *  1. ONE type param: `createEntityHooks<<Class>>(…)`. The factory defaults
 *     `TCreate`/`TUpdate` to `Partial<TEntity>`; the pts `<Class>Create` /
 *     `<Class>Update` schema types are unverifiable in our `dbEntities`
 *     consumers, so we don't import them.
 *  2. `name:` and the `getSyncMode('…')` key are the SINGULAR entity name —
 *     matching FE-2's `config.ts` keys (which are keyed by `entity.name`). pts
 *     keyed `name:` by table; our config table is keyed by entity name, so the
 *     `getSyncMode` lookup must use the same key.
 *  3. No state-machine block (this codegen has no transition concept).
 */

import { join } from 'node:path';
import type { EntityRegistryEntry, FrontendEmitContext } from './types';
import { sortEntities } from './types';
import { withBanner, writeFile } from './emit-utils';

const SOURCE_DESC_SET = 'the entity set';

/**
 * `entities/<name>.ts` — `createEntityHooks` wiring + destructured re-exports.
 * Entity type imported plain (`<Class>`) from `dbEntities` (per FE-2 decision).
 */
export function buildEntityHooksFile(
	entity: EntityRegistryEntry,
	ctx: FrontendEmitContext,
): string {
	const { camelName, className, name } = entity;

	const body = `import { createEntityHooks } from '@pattern-stack/frontend-patterns';
import { ${camelName}Collection } from '../collections/${name}';
import { ${camelName}Api } from '../api/${name}';
import { getSyncMode } from '../config';
import type { ${className} } from '${ctx.config.dbEntitiesImport}/${name}';

/**
 * Typed hooks for ${className}, wired via the framework factory.
 *
 * \`localFirst\` is resolved at call time from the entity's runtime sync mode
 * (\`getSyncMode('${name}')\`) — \`api\` mode is confirmed-write, everything else
 * is local-first (optimistic).
 */
export const ${camelName}Hooks = createEntityHooks<${className}>({
\tname: '${name}',
\tcollection: ${camelName}Collection,
\tapi: ${camelName}Api,
\tlocalFirst: () => getSyncMode('${name}') !== 'api',
});

// Per-entity hook re-exports for direct imports.
export const {
\tuseList: use${className}List,
\tuseGet: use${className},
\tuseCreate: useCreate${className},
\tuseUpdate: useUpdate${className},
\tuseDelete: useDelete${className},
\tkeys: ${camelName}Keys,
} = ${camelName}Hooks;
`;
	return withBanner(`entities/${name}.yaml`, body);
}

/**
 * `entities/index.ts` — re-export each entity's hooks + the 6 named hooks,
 * sorted by entity name. Mirrors pts `entities_index.ts.j2` (no state-machine
 * line).
 */
export function buildEntitiesIndexFile(ctx: FrontendEmitContext): string {
	const entities = sortEntities(ctx.entities);
	const blocks = entities.map((e) => {
		const { camelName, className, name } = e;
		return `export {
\t${camelName}Hooks,
\tuse${className}List,
\tuse${className},
\tuseCreate${className},
\tuseUpdate${className},
\tuseDelete${className},
\t${camelName}Keys,
} from './${name}';`;
	});
	return withBanner(SOURCE_DESC_SET, `${blocks.join('\n\n')}\n`);
}

/**
 * Emit `entities/<name>.ts` (sorted) + `entities/index.ts` into
 * `<outDir>/entities`. Returns written paths.
 */
export function emitEntities(ctx: FrontendEmitContext, outDir: string): string[] {
	const entitiesDir = join(outDir, 'entities');
	const entities = sortEntities(ctx.entities);
	const written: string[] = [];

	for (const entity of entities) {
		const filePath = join(entitiesDir, `${entity.name}.ts`);
		writeFile(filePath, buildEntityHooksFile(entity, ctx));
		written.push(filePath);
	}

	const indexPath = join(entitiesDir, 'index.ts');
	writeFile(indexPath, buildEntitiesIndexFile(ctx));
	written.push(indexPath);

	return written;
}
