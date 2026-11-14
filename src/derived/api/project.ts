/**
 * `deriveProjectApiSurface` — the whole project's generated API surface (ADR-046, PLAN §4.3).
 *
 * The per-entity derivation for every entity, answering "what `entity new --all` emits" (every entity of the set
 * is a wired `has_many` target, Q4), then one link pass over the result:
 *
 * 1. REL-1's own `buildRelationGraph` and `buildIncludeAllowlists`, over the context `loadRelationsEmitContext`
 *    builds — the relation graph is never re-walked from the YAML here (charter I1; the frontend's
 *    `graph-model.ts` is the precedent). The compiled include allowlists are attached as `http.includes`.
 * 2. Every `delegatesTo` is resolved against the target's surface. Two rules, each a warning — the command still
 *    succeeds, because the generator emits these files today and the consumer's `tsc` is what fails (Q5):
 *    - the delegate must be a method the target's surface lists, emitted or inherited (F7 V1, D4);
 *    - a `relation_many` must reach an `fk_finder` — a `queries:` finder of the same name takes different
 *      arguments or returns one row (F7 V2/V3).
 * 3. Declarations are paired into `RelationApiSurface`s, and `generates` is indexed from the methods' origins.
 * 4. Junction and `relationship:` definitions are listed under `unmodelled` (#679).
 *
 * CLI-only: it imports the relations emitter and the schema registry, whose module graph does not ship to hygen.
 * Not in `package.json` `files`.
 */

import { existsSync, statSync } from 'node:fs';

import { buildRelationGraph, junctionIdentity, type RelationGraph } from '../../emitters/relations/build-graph.js';
import { buildIncludeAllowlists } from '../../emitters/relations/build-includes.js';
import {
	loadRelationsEmitContext,
	type RelationsConfigInput,
} from '../../emitters/relations/load-context.js';
import type { RelationEdge, RelationsEmitContext } from '../../emitters/relations/types.js';
import { composePatterns, declaredPatternNames, type PatternDeclaringEntity } from '../../patterns/compose.js';
import { getPattern } from '../../patterns/registry.js';
import '../../patterns/library/index.js';
import type { EntityDefinition } from '../../schema/entity-definition.schema.js';
import { findYamlFiles } from '../../utils/find-yaml-files.js';
import { detectYamlType, loadRelationshipFromYaml } from '../../utils/yaml-loader.js';
import {
	deriveEntityApiSurface,
	type EntityBlockInput,
	type EntityDefinitionInput,
	type PatternCompositionInput,
} from './entity.js';
import type {
	EntityApiSurface,
	MethodRef,
	Origin,
	ProjectApiSurface,
	RelationApiSurface,
	ServiceMethod,
} from './types.js';

// ============================================================================
// Input
// ============================================================================

export interface ProjectApiContext {
	/** REL-1's emit context — the entity + junction set, from `loadRelationsEmitContext`. */
	relations: RelationsEmitContext;
	/** The project's `relationship:` definitions (`relationships/`), by name. Listed under `unmodelled` only. */
	relationships: readonly { name: string }[];
}

/**
 * Load the whole-set input from a project: REL-1's context through its own loader, plus the `relationship:`
 * definitions. App patterns must already be registered (`loadAppPatternsForCli`), as for every whole-set step.
 * The junctions and relationships directories are the caller's: neither is a `paths.*` key, and this reader
 * carries no default of its own.
 */
export function loadProjectApiContext(
	cwd: string,
	config: RelationsConfigInput | null | undefined,
	dirs: { entitiesDir?: string; junctionsDir: string; relationshipsDir: string },
): ProjectApiContext {
	const { ctx } = loadRelationsEmitContext(cwd, config, {
		entitiesDir: dirs.entitiesDir,
		junctionsDir: dirs.junctionsDir,
	});
	return { relations: ctx, relationships: loadRelationshipNames(dirs.relationshipsDir) };
}

function loadRelationshipNames(dir: string): { name: string }[] {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
	const names: { name: string }[] = [];
	for (const file of findYamlFiles(dir)) {
		if (detectYamlType(file) !== 'relationship') continue;
		const result = loadRelationshipFromYaml(file);
		if (result.success) names.push({ name: result.definition.relationship.name });
	}
	return names.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The resolved pattern composition, as `entity-locals.js`'s `resolvePatternComposition` returns it — the same
 * `composePatterns` over the same registry. `src/` cannot import a template module (it is outside the build), so
 * the mapping is restated here; `project-api-surface.test.ts` holds the two equal for every fixture entity.
 */
export function patternComposition(entity: PatternDeclaringEntity & { name: string }): PatternCompositionInput {
	const composed = composePatterns(declaredPatternNames(entity), getPattern, { entity: entity.name });
	if (composed.errors.length > 0) {
		throw new Error(
			`[codegen] pattern composition failed for '${entity.name}':\n  ` +
				composed.errors.map((e) => e.message).join('\n  '),
		);
	}
	const def = composed.spine;
	if (!def) {
		throw new Error(
			`Pattern '${composed.spineName}' is not registered, and the library 'Base' pattern is also missing.`,
		);
	}
	return {
		patternName: def.name,
		repositoryBaseClass: def.repositoryClass ?? '',
		serviceBaseClass: def.serviceClass ?? '',
		repositoryInheritedMethods: def.repositoryInheritedMethods ?? [],
		serviceInheritedMethods: def.serviceInheritedMethods ?? [],
		capabilities: composed.capabilities,
	};
}

// ============================================================================
// The derivation
// ============================================================================

const UNMODELLED_JUNCTION =
	"a junction's own module (repository, service, use cases) is not derived yet — #679 folds `pattern: Junction` " +
	'and `relationship:` into one concept first; its fan-out onto each parent is derived';
const UNMODELLED_RELATIONSHIP =
	"a `relationship:` definition's module is not derived yet — #679 folds `pattern: Junction` and " +
	'`relationship:` into one concept first';

export function deriveProjectApiSurface(ctx: ProjectApiContext): ProjectApiSurface {
	const rel = ctx.relations;
	const definitions = [...rel.definitions.values()].sort((a, b) => a.entity.name.localeCompare(b.entity.name));
	const blocks = new Map<string, EntityBlockInput>(definitions.map((d) => [d.entity.name, d.entity]));
	const entityLookup = (name: string): EntityBlockInput | null => blocks.get(name) ?? null;
	const allNames = definitions.map((d) => d.entity.name);

	const entities: Record<string, EntityApiSurface> = {};
	for (const definition of definitions) {
		const input: EntityDefinitionInput = definition;
		entities[definition.entity.name] = deriveEntityApiSurface({
			definition: input,
			junctions: rel.junctions,
			composition: patternComposition(definition.entity),
			wiredTargets: allNames,
			entityLookup,
		});
	}

	// ── 1. REL-1's graph and allowlists — the same calls the manifest emitter makes ──
	const graph = buildRelationGraph(rel);
	for (const compiled of buildIncludeAllowlists(rel, graph)) {
		const surface = entities[compiled.entity];
		if (!surface || compiled.routes.length === 0) continue;
		surface.http.includes = compiled.routes.map((r) => ({
			route: r.route,
			maxDepth: r.maxDepth,
			paths: r.paths.map((p) => ({ path: p.path, depth: p.depth })),
		}));
	}

	const junctionNames = new Set(rel.junctions.map((j) => junctionIdentity(j).name));

	return {
		entities,
		relations: relationSurfaces(definitions, graph, entities),
		unmodelled: [
			...rel.junctions.map((j) => ({ name: junctionIdentity(j).name, kind: 'junction' as const, reason: UNMODELLED_JUNCTION })),
			...ctx.relationships.map((r) => ({ name: r.name, kind: 'relationship' as const, reason: UNMODELLED_RELATIONSHIP })),
		].sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind)),
		warnings: delegateWarnings(entities, junctionNames),
	};
}

// ============================================================================
// 2. Delegates
// ============================================================================

/** The declaration a method's origin names, as REL-1 spells an origin: `contact.relationships.account`. */
function originId(origin: Origin): string | undefined {
	if (origin.from !== 'yaml') return undefined;
	const { doc, path: at } = origin.at;
	return doc.kind === 'junction' ? `junction ${doc.name}` : [doc.name, ...at].join('.');
}

function className(surface: EntityApiSurface, layer: MethodRef['layer']): string {
	return layer === 'repository' ? surface.repository.className : surface.service.className;
}

/**
 * Every `delegatesTo` resolved against its target's surface. A delegate into a junction's own service is not
 * checked: the junction module is `unmodelled` (#679), so there is no surface to resolve it against.
 */
function delegateWarnings(entities: Record<string, EntityApiSurface>, junctionNames: ReadonlySet<string>): string[] {
	const warnings: string[] = [];
	for (const surface of Object.values(entities)) {
		for (const method of surface.service.methods) {
			const to = method.delegatesTo;
			if (!to || junctionNames.has(to.entity)) continue;
			const warning = checkDelegate(surface, method, to, entities[to.entity]);
			if (warning) warnings.push(warning);
		}
	}
	return warnings;
}

function checkDelegate(
	from: EntityApiSurface,
	method: ServiceMethod,
	to: MethodRef,
	target: EntityApiSurface | undefined,
): string | undefined {
	const site = originId(method.origin) ?? `${from.entity}.${method.name}`;
	const callee = `\`${target ? className(target, to.layer) : to.entity}.${to.method}\``;
	const head = `${site}: \`${from.service.className}.${method.name}\` calls ${callee}`;

	const listed = target
		? (to.layer === 'repository' ? target.repository.methods : target.service.methods).find((m) => m.name === to.method)
		: undefined;
	// Rule 1 — the delegate exists on the target, emitted or inherited (F7 V1, D4).
	if (!listed) return `${head}, which ${to.entity} does not emit`;
	// Rule 2 — a to-many relation reaches an FK finder, not a `queries:` finder of the same name (F7 V2/V3).
	if (method.kind === 'relation_many' && listed.kind !== 'fk_finder') {
		return `${head}, which is a \`queries:\` finder, not an FK finder`;
	}
	return undefined;
}

// ============================================================================
// 3. Relations
// ============================================================================

function relationSurfaces(
	definitions: readonly EntityDefinition[],
	graph: RelationGraph,
	entities: Record<string, EntityApiSurface>,
): RelationApiSurface[] {
	// REL-1's edges by origin — a declaration's include keys are the manifest keys it produced.
	const edgesByOrigin = new Map<string, RelationEdge[]>();
	for (const { edges } of graph.tables) {
		for (const edge of edges) {
			const list = edgesByOrigin.get(edge.origin) ?? [];
			list.push(edge);
			edgesByOrigin.set(edge.origin, list);
		}
	}

	// Every method, either layer, by the declaration that won it.
	const generatesById = new Map<string, MethodRef[]>();
	for (const surface of Object.values(entities)) {
		for (const layer of ['repository', 'service'] as const) {
			for (const m of surface[layer].methods) {
				const id = originId(m.origin);
				if (!id) continue;
				const list = generatesById.get(id) ?? [];
				list.push({ entity: surface.entity, layer, method: m.name });
				generatesById.set(id, list);
			}
		}
	}

	const relations: RelationApiSurface[] = [];
	const surfaceOf = (
		id: string,
		from: string,
		to: string,
		kind: RelationApiSurface['kind'],
		inverseOf?: string,
	): RelationApiSurface => {
		return {
			id,
			from,
			to,
			kind,
			...(inverseOf ? { inverseOf } : {}),
			generates: generatesById.get(id) ?? [],
			includeKeys: (edgesByOrigin.get(id) ?? []).map((e) => ({ table: e.sourceTable, key: e.key })),
		};
	};

	// Declared `relationships:` — exactly the ones REL-1 made an edge for (it skips `through:` paths and
	// targets with no YAML, with its own warning).
	const declared = definitions.flatMap((def) =>
		Object.entries(def.relationships ?? {})
			.map(([name, r]) => ({ id: `${def.entity.name}.relationships.${name}`, entity: def.entity.name, name, r }))
			.filter((d) => edgesByOrigin.has(d.id)),
	);
	for (const d of declared) {
		const inverse = pairOf(d, declared);
		relations.push(surfaceOf(d.id, d.entity, d.r.target, d.r.type as RelationApiSurface['kind'], inverse?.id));
	}

	// Roles (CAP-2). REL-1's graph carries no role edge (`build-graph.ts`, the CAP-2 seam), so `includeKeys` is
	// empty; a `cardinality: one` role's belongs_to methods name the role as their origin.
	for (const def of definitions) {
		for (const [role, r] of Object.entries(def.roles ?? {})) {
			relations.push(surfaceOf(`${def.entity.name}.roles.${role}`, def.entity.name, r.target, 'role'));
		}
	}

	// Junctions — REL-1's `junction <name>` origin; the fan-out methods on each parent name the junction.
	for (const origin of edgesByOrigin.keys()) {
		if (!origin.startsWith('junction ')) continue;
		const name = origin.slice('junction '.length);
		const edges = edgesByOrigin.get(origin) ?? [];
		const between = edges.find((e) => e.from.through);
		const tableToEntity = new Map(Object.values(entities).map((s) => [s.plural, s.entity]));
		relations.push(
			surfaceOf(
				origin,
				(between && tableToEntity.get(between.sourceTable)) ?? name,
				(between && tableToEntity.get(between.targetTable)) ?? name,
				'junction',
			),
		);
	}

	return relations.sort((a, b) => a.id.localeCompare(b.id));
}

interface Declared {
	id: string;
	entity: string;
	name: string;
	r: { type: string; target: string; foreign_key: string; inverse?: string };
}

/**
 * The declaration on the other entity this one is the inverse of. An explicit `inverse:` names it; otherwise
 * `A.belongs_to(B, fk)` pairs with `B.has_many | has_one(A, foreign_key: fk)` and back. Only an unambiguous
 * match pairs — two candidates leave both unpaired rather than guessing.
 */
function pairOf(d: Declared, all: readonly Declared[]): Declared | undefined {
	const explicit = d.r.inverse ?? all.find((o) => o.entity === d.r.target && o.r.inverse === d.name && o.r.target === d.entity)?.name;
	if (explicit) return all.find((o) => o.entity === d.r.target && o.name === explicit);
	const toMany = (t: string) => t === 'has_many' || t === 'has_one';
	const candidates = all.filter(
		(o) =>
			o !== d &&
			o.entity === d.r.target &&
			o.r.target === d.entity &&
			o.r.foreign_key === d.r.foreign_key &&
			((d.r.type === 'belongs_to' && toMany(o.r.type)) || (toMany(d.r.type) && o.r.type === 'belongs_to')),
	);
	return candidates.length === 1 ? candidates[0] : undefined;
}
