/**
 * Frontend emitter — banner + file-writing helpers (ADR-038, FE-2).
 *
 * The banner mirrors the house `generatedBanner()` in
 * `src/cli/shared/adapter-emission-generator.ts` — the shape is copied here so
 * the emitter has no dependency on `src/cli/**` (emitters must not import across
 * from the CLI layer).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { deriveProjectApiSurface } from '../../derived/api/project.js';
import type { ProjectApiSurface, YamlRef } from '../../derived/api/types.js';
import { camelCase } from '../../config/file-naming.js';
import { inheritsOf } from '../../schema/inheritance.js';
import { generating } from '../../utils/generated-file.js';
import type { EntityRegistryEntry, FrontendEmitContext } from './types';

const surfaceCache = new WeakMap<FrontendEmitContext, ProjectApiSurface | null>();

/**
 * The project's derived API surface (ADR-046), once per emit. The frontend asks it what the backend generates —
 * a create / update / delete route — instead of re-deciding it: `deriveProjectApiSurface` is the one owner of
 * route and use-case existence (`generate: { writes: false }`, a base with no create route), and the backend's
 * templates print from the same derivation. It is fed the same relation inputs `buildClientGraph` hands REL-1's
 * `buildRelationGraph` (charter I1). `null` for a context built without `definitions` (a registry-only fixture):
 * it has no families and no write switch, so every mutation exists.
 */
export function projectSurface(ctx: FrontendEmitContext): ProjectApiSurface | null {
	if (surfaceCache.has(ctx)) return surfaceCache.get(ctx) ?? null;
	const surface = ctx.definitions
		? deriveProjectApiSurface({
				relations: {
					entities: ctx.entities,
					definitions: ctx.definitions,
					junctions: ctx.junctions ?? [],
					tenancyColumn: ctx.config.tenancyColumn,
				},
				relationships: [],
			})
		: null;
	surfaceCache.set(ctx, surface);
	return surface;
}

export interface WriteRoutes {
	create: boolean;
	update: boolean;
	delete: boolean;
	/**
	 * Why each missing mutation is missing, spelled from the derivation's own `YamlRef` (`createDisabledBy`,
	 * `writesDisabledBy`, `http.disabledBy`): `<entity>.<yaml path>` plus its note. Absent for a mutation that exists.
	 * The api client prints it, so a stub never states a reason the derivation did not give.
	 */
	why: { create?: string; update?: string; delete?: string };
}

/** `<entity>.<yaml path> (<note>)` — the declaration that caused a derived fact, as the derivation records it. */
function describeRef(ref: YamlRef): string {
	const at = [ref.doc.name, ...ref.path].join('.');
	return ref.note ? `${at} (${ref.note})` : at;
}

/**
 * Which mutations the backend generates for this entity — read from its derived HTTP routes
 * (`apiSurface.http.routes`, the list the backend's controller template prints), because the frontend calls REST
 * routes: an `api: false` entity has use cases but no routes, so it has no mutation here either
 * (`generate: { writes: false }` removes all three; a discriminator base whose every kind has a child removes
 * `create`, RFC-0006 §4.1). The api client, the hooks, the store and the field capabilities all ask here, so no
 * mutation is emitted for a route that does not exist.
 *
 * A context with no `definitions` (a registry-only fixture) has no families and no write switch, so every mutation
 * exists. A context that HAS definitions but whose surface lacks the entity is a registry / definitions
 * disagreement, and throws: answering "everything exists" there would emit routes the backend does not generate.
 */
export function writeRoutes(entity: EntityRegistryEntry, ctx: FrontendEmitContext): WriteRoutes {
	const project = projectSurface(ctx);
	if (!project) return { create: true, update: true, delete: true, why: {} };
	const surface = project.entities[entity.name];
	if (!surface) {
		throw new Error(
			`frontend emit: entity '${entity.name}' is in the registry but has no derived API surface, so which ` +
				'mutations the backend generates for it is unknown. The registry and the definitions disagree.',
		);
	}
	const has = (handler: string): boolean => surface.http.routes.some((r) => r.handler === handler);
	const writesOrHttp = surface.writesDisabledBy ?? surface.http.disabledBy;
	const create = has('create');
	const update = has('update');
	const del = has('remove');
	const createWhy = surface.createDisabledBy ?? writesOrHttp;
	return {
		create,
		update,
		delete: del,
		why: {
			...(create || !createWhy ? {} : { create: describeRef(createWhy) }),
			...(update || !writesOrHttp ? {} : { update: describeRef(writesOrHttp) }),
			...(del || !writesOrHttp ? {} : { delete: describeRef(writesOrHttp) }),
		},
	};
}

/**
 * House `@generated` banner. `sourceDesc` describes the input the file was
 * rendered from (e.g. `entities/opportunity.yaml`, `the entity set`).
 */
export function generatedBanner(sourceDesc: string): string {
	return (
		`// @generated by @pattern-stack/codegen from ${sourceDesc} — DO NOT EDIT.\n` +
		'// Hand edits are overwritten on re-emit. Regenerate with `bun run codegen`.'
	);
}

/**
 * Prefix a file body with the banner and a single blank line. Pure — used by
 * every builder so the banner convention lives in exactly one place.
 */
export function withBanner(sourceDesc: string, body: string): string {
	return `${generatedBanner(sourceDesc)}\n\n${body}`;
}

/**
 * Write a file, creating parent directories. Thin wrapper over fs so the emit
 * steps stay declarative (build string → write).
 */
export function writeFile(outPath: string, content: string): void {
	generating(outPath, () => {
		mkdirSync(dirname(outPath), { recursive: true });
		writeFileSync(outPath, content);
	});
}

/**
 * The flat shape a joined-table CHILD speaks over HTTP and on the client (RFC-0006 §3.4, §5): the base's
 * columns and its own. `null` for an entity that does not inherit. The ONE owner of that naming and of "is a child":
 * the api client defines `withBaseType` and `flatInputType`, `entities/<child>.ts` types its hooks with the latter, and
 * `graph/<child>.ts` re-exports the former — each reads the names here, and emit-graph gates on this too.
 *
 * `discriminatorProp` is the base's own discriminator column (`kind`, or whatever the base calls it), which the
 * child's table also carries as a copy: the type omits exactly that one, never a hard-coded `'kind'`.
 */
export interface FlatChild {
	base: EntityRegistryEntry;
	discriminatorProp: string;
	/** `<Child>WithBase` — the backend's `<Child>Flat` on the client. */
	withBaseType: string;
	/** `<Child>FlatInput` — a flat create / update body. */
	flatInputType: string;
}

export function flatChild(entity: EntityRegistryEntry, ctx: FrontendEmitContext): FlatChild | null {
	const def = ctx.definitions?.get(entity.name);
	const decl = def ? inheritsOf(def) : null;
	if (!decl) return null;
	const base = ctx.entities.find((e) => e.name === decl.base);
	const discriminator = ctx.definitions?.get(decl.base)?.discriminator;
	if (!base || typeof discriminator !== 'string') return null;
	return {
		base,
		discriminatorProp: camelCase(discriminator),
		withBaseType: `${entity.className}WithBase`,
		flatInputType: `${entity.className}FlatInput`,
	};
}
