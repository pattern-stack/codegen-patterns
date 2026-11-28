/**
 * The supported app shapes — the ONE table of `target.wiring` × `target.http` combinations (PW-3, ADR-047's
 * one-axis-per-key rule). Like `TARGET_PAIRS`, every reader derives from it: the config schema offers exactly its
 * values, and the refusal of an unsupported combination names its rows.
 *
 * - `wiring`: how the generated classes are composed — `nest` (decorators, a Nest module per entity) or `pattern-stack` (no
 *   decorators; one composition and one `@pattern-stack/wiring` manifest per context).
 * - `http`: the HTTP layer — `nest` (Nest controllers) or `none` (no HTTP: a CLI, hook or MCP app). H-1 adds `hono`.
 *
 * Both keys are optional in `target:`, and absent means the first row, so every config written before them parses
 * to the same output.
 *
 * Hygen-safe: reached from the config schema and `entity-locals.js`; it imports nothing.
 */

export const TARGET_APPS = [
	{
		wiring: 'nest',
		http: 'nest',
		description: 'A NestJS app: a Nest module per entity, Nest controllers',
	},
	{
		wiring: 'pattern-stack',
		http: 'none',
		description:
			'No NestJS and no HTTP: decorator-free classes composed per context with @pattern-stack/wiring (PW-3)',
	},
] as const;

export type TargetWiring = (typeof TARGET_APPS)[number]['wiring'];
export type TargetHttp = (typeof TARGET_APPS)[number]['http'];
export type TargetApp = (typeof TARGET_APPS)[number];

/** Every value each key takes, in table order, for the schema's enums. */
export const TARGET_WIRINGS = [...new Set(TARGET_APPS.map((a) => a.wiring))] as [TargetWiring, ...TargetWiring[]];
export const TARGET_HTTPS = [...new Set(TARGET_APPS.map((a) => a.http))] as [TargetHttp, ...TargetHttp[]];

/** The default app, when `target:` names neither key — the first row. */
export const DEFAULT_TARGET_APP = TARGET_APPS[0];

/** The supported combinations as `target:` spells them, for messages and docs: `{ wiring: pattern-stack, http: none }`. */
export function supportedTargetApps(apps: ReadonlyArray<{ wiring: string; http: string }> = TARGET_APPS): string[] {
	return apps.map((a) => `{ wiring: ${a.wiring}, http: ${a.http} }`);
}

/**
 * The row for a `target:`'s wiring and http, each defaulting to the first row's. An absent `http` follows the
 * wiring's own row (`wiring: pattern-stack` alone is `pattern-stack/none`). Returns null for an unsupported combination; the schema
 * refuses it before any reader asks.
 */
export function targetAppRow(target: { wiring?: string; http?: string }): TargetApp | null {
	const wiring = target.wiring ?? DEFAULT_TARGET_APP.wiring;
	const rows = TARGET_APPS.filter((a) => a.wiring === wiring);
	if (target.http === undefined) return rows[0] ?? null;
	return rows.find((a) => a.http === target.http) ?? null;
}

/** The resolved app for a parsed `target:` (the schema has already refused an unsupported combination). */
export function targetApp(target: { wiring?: string; http?: string }): TargetApp {
	const row = targetAppRow(target);
	if (!row) {
		throw new Error(
			`target { wiring: ${target.wiring}, http: ${target.http} } is not supported; supported: ${supportedTargetApps().join(', ')}`,
		);
	}
	return row;
}

/** Is this `target:` pattern-stack wiring? */
export function isPatternStackWiring(target: { wiring?: string }): boolean {
	return (target.wiring ?? DEFAULT_TARGET_APP.wiring) === 'pattern-stack';
}
