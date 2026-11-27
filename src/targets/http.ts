/**
 * What each `target.http` value emits under pattern-stack wiring (H-1b): one row per value, keyed like `TARGET_APPS`,
 * so no reader branches on the value. A row is the layer's facts (data only); its text is its row in
 * `HTTP_RENDERERS` (`src/emitters/http/`), typed so a layer without one is a `tsc` error.
 *
 * - `nest`: never under pattern-stack wiring (`TARGET_APPS` refuses the pair); Nest's controllers are the Nest
 *   pipeline's.
 * - `none`: no HTTP layer.
 * - `hono`: each entity's routes as views of its commands, and `<generated>/http.ts`'s `createApp`.
 *
 * Hygen-safe: reached from `entity-locals.js`; it imports only `apps.ts` and `rowFor`.
 */
import { rowFor } from '../utils/keyed-row.js';
import { targetApp, type TargetHttp } from './apps.js';

export interface PatternStackHttpLayer {
	/** Each entity's routes file, beside its commands: `<entity><suffix>`. */
	readonly routesFileSuffix: string;
	/** The runtime files vendored with it, as `VENDORED_RUNTIME_FILES` names them (`runtime/…`). */
	readonly runtimeFiles: readonly string[];
	/** The runtime module its routes and app file import (`runtimeImport(mode, runtimeModule)`). */
	readonly runtimeModule: string;
	/** What the app installs for it, as `bun add` takes them. */
	readonly packages: readonly string[];
	/** The settings it reads at startup (SET-1): `src/derived/settings` lists them with the project's. */
	readonly settings: readonly {
		readonly group: string;
		readonly key: string;
		readonly env: string;
		readonly default: string;
		readonly format: 'port';
		readonly description: string;
	}[];
}

export const HTTP_LAYERS = {
	nest: null,
	none: null,
	hono: {
		routesFileSuffix: '.routes.ts',
		runtimeFiles: ['http/hono.ts'],
		runtimeModule: 'http/hono',
		packages: ['hono@4', '@hono/node-server@1'],
		settings: [{ group: 'http', key: 'port', env: 'PORT', default: '3000', format: 'port', description: 'The port the HTTP server listens on.' }],
	},
} as const satisfies { readonly [H in TargetHttp]: PatternStackHttpLayer | null };

/** The `http` values that have a layer under pattern-stack wiring. */
export type PatternStackHttp = { [H in TargetHttp]: (typeof HTTP_LAYERS)[H] extends null ? never : H }[TargetHttp];

/** The layer a pattern-stack `target:` emits, or null for none. */
export function patternStackHttpLayer(target: { wiring?: string; http?: string }): PatternStackHttpLayer | null {
	return rowFor('target.http', HTTP_LAYERS, targetApp(target).http);
}

/** The layer's `http` value, or null for none. */
export function patternStackHttpName(target: { wiring?: string; http?: string }): PatternStackHttp | null {
	const http = targetApp(target).http;
	return rowFor('target.http', HTTP_LAYERS, http) === null ? null : (http as PatternStackHttp);
}
