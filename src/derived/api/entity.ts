/**
 * `deriveEntityApiSurface` — one entity's generated API surface, derived once (ADR-046).
 *
 * Pure: everything it reads is in its input, and every input is something `buildBackendLocals` already holds —
 * the entity definition, the junction set, the resolved pattern composition, the `has_many` targets that will
 * exist, and the cross-entity lookup. It reads no file and resolves no pattern.
 *
 * One input, two spellings: hygen hands it raw YAML, the CLI zod-parsed definitions. The input types below are
 * the narrow structure both satisfy, and every read tolerates a key the schema would have defaulted (`api`
 * absent ⇒ enabled). `src/__tests__/derived/raw-parsed.test.ts` holds the two equal.
 *
 * Hygen-safe: `entity-locals.js` will import this module (ADR-046 Phase B), so it imports only modules that ship
 * in the package's `files`.
 */

import { NEST_SUCCESS_STATUS } from '../../../runtime/commands.js';
import { entityModuleNaming } from '../../config/module-tree.js';
import { junctionName } from '../../config/junction-naming.js';
import { baseOnlyKinds, INHERITS_PATH, inheritsOf, naturalKeyIndexOf, type InheritanceBase, type InheritanceChild } from '../../schema/inheritance.js';
import { deriveRoleRelationships, type RoleDefinition } from '../../roles/derive.js';
import {
	controllerClassName,
	entityClassName,
	finderName,
	fkFinderName,
	idParamName,
	includesConstName,
	junctionAttachName,
	junctionDetachName,
	junctionListName,
	junctionSetPrimaryName,
	operationId,
	FAMILY_METHOD,
	paramName,
	queryUseCaseClassName,
	relationMethodName,
	repositoryClassName,
	routePath,
	searchControllerClassName,
	nestDefaultOperationId,
	serviceClassName,
	useCaseClassName,
	useCaseKey,
	commandName,
	commandsConstName,
	notFoundMessage,
	routesFunctionName,
	registerPathsName,
	type JunctionSide,
	publishedWriteEvent,
} from './names.js';
import type {
	EntityApiSurface,
	EntityCommand,
	MethodRef,
	Origin,
	Param,
	ReadOptionsShape,
	RepositoryMethod,
	Route,
	ServiceMethod,
	Shape,
	UseCase,
	YamlPath,
	YamlRef,
} from './types.js';

// ============================================================================
// Input — the structure raw YAML and the zod-parsed definition share
// ============================================================================

/** An `entity:` block — this entity's, or another's through `entityLookup`. */
export interface EntityBlockInput {
	name: string;
	plural?: string;
	context?: string;
}

export interface RelationshipInput {
	type: string;
	target: string;
	foreign_key?: string;
	through?: string;
	/** Set on a `belongs_to` a `cardinality: one` role derived (CAP-2). */
	role?: string;
}

/** A `queries:` entry: a by-column finder, or the `name: search` declaration. */
export interface QueryInput {
	by?: readonly string[];
	unique?: boolean;
	select?: readonly string[];
	order?: string;
	via?: string;
	name?: string;
	filters?: readonly string[];
}

export interface EntityDefinitionInput {
	entity: EntityBlockInput;
	relationships?: Readonly<Record<string, RelationshipInput>> | null;
	roles?: Readonly<Record<string, RoleDefinition>> | null;
	queries?: readonly QueryInput[] | null;
	api?: boolean | { enabled?: boolean; includes?: Readonly<Record<string, unknown>> } | null;
	generate?: { writes?: boolean; commands?: boolean } | null;
	/** `inherits:` (RFC-0006) — a bare base name or `{ base, as? }`. */
	inherits?: string | { base: string; as?: string };
	/** The base's kind column (RFC-0006 §1.1). */
	discriminator?: string;
	/** `unique_indexes:` — `natural_key: true` on one entry names the `upsertByNaturalKey` conflict target (§4.2). */
	unique_indexes?: readonly { natural_key?: boolean }[] | null;
	eav?: boolean;
	eav_value_table?: boolean;
	/** The definition entity an `eav_value_table: true` entity's values belong to. */
	eav_definition_table?: string | null;
	/** `emits:` (EVT-7) — the event types the entity's writes publish. Absent / `[]`: none. */
	emits?: readonly string[] | null;
}

/**
 * The YAML declaration that turns the write side off — create / update / delete use cases, their routes and
 * their module providers — or `null` when writes are emitted: `generate.writes: false`. A child's `inherits:` is no
 * cause (RFC-0006 §13.2, #875 S5): its flat DTOs extend the base's and its repository's pair write is the write.
 *
 * The ONE owner of this decision — `deriveEntityApiSurface` reads it for the use cases and routes, and the
 * templates read those — so another cause is one edit here.
 */
export function writesDisabledBy(definition: {
	entity: { name: string };
	// Required key (its value may be undefined): a narrowed call that leaves it out does not compile, instead of
	// silently turning writes on.
	generate: EntityDefinitionInput['generate'];
}): YamlPath | null {
	if (definition.generate?.writes === false) return ['generate', 'writes'];
	return null;
}

/**
 * The YAML declaration that turns the entity's generated commands off (H-1) — `generate.commands: false` — or `null`
 * when it has them. The ONE owner: `deriveEntityApiSurface` reads it for `commands`, and the commands template and the
 * whole-set table read that, so an entity with none gets no file and no entry.
 */
export function commandsDisabledBy(definition: { generate: EntityDefinitionInput['generate'] }): YamlPath | null {
	if (definition.generate?.commands === false) return ['generate', 'commands'];
	return null;
}

/**
 * Whether an entity has HTTP routes under an HTTP layer (H-1b): its HTTP is on and it has commands to view (routes are
 * views of commands). The one rule: the routes template, its file path and `<generated>/http.ts` read it (through
 * `http.routesFunction`, present exactly when this holds).
 */
export function routesOn(definition: Pick<EntityDefinitionInput, 'api' | 'generate'>): boolean {
	return apiEnabled(definition) && commandsDisabledBy({ generate: definition.generate }) === null;
}

/**
 * The declaration that removes a base's own `create` — the use case, the `POST` route and its provider — or `null`
 * when it has one (RFC-0006 §4.1, §5, #875 S5). A base's create accepts only base-only kinds, so a base whose every
 * kind has a child table has none: a row of any kind is created through its child's `POST`. The cause is the
 * `discriminator:`, with the kinds it admits named in the note.
 *
 * `kinds` is required, not defaulted: an unknown list (`null`) on a base is an error, not "every kind is base-only".
 * A non-base, or a base with no child at all, always has a create. Writes being off (`writesDisabledBy`) removes it
 * too, but that is the caller's: this answers only the family question.
 */
export function createDisabledBy(
	definition: { discriminator?: string },
	inheritanceChildren: readonly InheritanceChild[],
	kinds: readonly string[] | null,
): YamlPath | null {
	if (typeof definition.discriminator !== 'string' || inheritanceChildren.length === 0) return null;
	// `== null`: a JS caller (entity-locals.js) that omits the key gets the named error, not a TypeError.
	if (kinds == null) {
		throw new Error(
			`[codegen] discriminator '${definition.discriminator}': its kinds are unknown, so whether the base has a create cannot be decided.`,
		);
	}
	return baseOnlyKinds(kinds, inheritanceChildren.map((c) => c.as)).length === 0 ? ['discriminator'] : null;
}

/**
 * A `roles:` block merged into `relationships` (CAP-2: a `cardinality: one` role IS a belongs_to), exactly as
 * `prompt.js` merges it, so a definition that arrives already merged comes out the same.
 */
function mergedRelationships(definition: EntityDefinitionInput): Record<string, RelationshipInput> {
	return {
		...(definition.relationships ?? {}),
		...deriveRoleRelationships(definition.roles ?? undefined),
	};
}

/** The repository kinds the service forwards verbatim (RFC-0006 S3). */
function isFamilyReadKind(kind: RepositoryMethod['kind']): kind is 'with_base' | 'list_flat' | 'count_flat' | 'all_kinds' | 'kind_by_id' | 'list_kind' | 'count_kind' | 'orphans' {
	return (
		kind === 'with_base' ||
		kind === 'list_flat' ||
		kind === 'count_flat' ||
		kind === 'all_kinds' ||
		kind === 'kind_by_id' ||
		kind === 'list_kind' ||
		kind === 'count_kind' ||
		kind === 'orphans'
	);
}

/**
 * Can this entity's repository name a `with` — is there a typed include? REL-2 (#587) §2.5: yes when its table
 * carries an edge in the relations manifest. Three things put one there: a direct relationship of its own
 * (`through:` ones emit no edge), a child's `inherits:` (its base edge), and a base's children (one edge per
 * child table, RFC-0006 §3.1) — edges its own YAML does not declare, so a family member has a typed include
 * whatever it writes under `relationships:`.
 *
 * A fourth input is counted without an edge: a `cardinality: one` role (CAP-2 — a belongs_to) is in
 * `mergedRelationships`, so the derivation and the gate agree, but REL-1 emits no manifest edge for it yet (the
 * CAP-2 seam, `build-graph.ts`). A role-only `api.includes` passes the gate and every role path is then refused at
 * path resolution (`names no relation at 'caller'`).
 *
 * The ONE owner: `deriveEntityApiSurface` reads it for `typedInclude` and every read's `readOptions`, and the
 * include-allowlist gate (`build-includes.ts`) for "would this allowlist ever be reached".
 */
export function hasTypedInclude(
	definition: EntityDefinitionInput,
	inheritanceChildren: readonly InheritanceChild[],
): boolean {
	return (
		Object.values(mergedRelationships(definition)).some((rel) => !rel.through) ||
		inheritsOf(definition) !== null ||
		inheritanceChildren.length > 0
	);
}

/**
 * Which half of the family read surface this entity carries (RFC-0006 §3, #875): a child (it `inherits:`) gets the
 * flat reads through its base; a base gets the cross-kind reads only when it has at least one child table — a base
 * with none has every kind base-only and its discriminator is just an enum.
 */
export function familyReadSurface(
	definition: EntityDefinitionInput,
	inheritanceChildren: readonly InheritanceChild[],
): { child: boolean; crossKind: boolean } {
	return {
		child: inheritsOf(definition) !== null,
		crossKind: typeof definition.discriminator === 'string' && inheritanceChildren.length > 0,
	};
}

/**
 * The write half of the family surface (RFC-0006 §4, #875 S4) and the natural-key upsert — which methods exist, and
 * which declaration causes each:
 *
 * - `pairWrite` — a child (`inherits:`): `create` / `update` / `delete` in its repository and `create` / `update` in
 *   its service override the inherited ones, because the inherited `create` would insert a row with no base row.
 * - `upsert` — `upsertByNaturalKey`. `'own'`: the entity declares `natural_key: true` on a `unique_indexes` entry.
 *   `'through_base'`: a child whose base declares one (R11: a child declares none of its own). A child whose base
 *   declares none has no upsert — there is no base conflict target to write through.
 * - `kindGuardUpdate` — any base (`discriminator:`): its repository's `update` refuses a `kind` key, whether or not a
 *   kind has a child table (the discriminator is immutable either way).
 * - `kindGuardCreate` — a base with at least one child table: its repository's `create` and `upsertByNaturalKey` refuse a
 *   kind that has one (`KindRequiresChildError`). The repository is the one owner, beside `KindImmutableError`; the service
 *   forwards and keeps no copy (D16).
 *
 * The ONE owner: its readers are `deriveEntityApiSurface` (the methods) and `family-reads.test.ts`; the templates
 * read the methods, not this. `inheritanceBase` is required, not defaulted: an absent base would read as "no upsert through it" and
 * silently drop a child's.
 */
export function familyWriteSurface(
	definition: EntityDefinitionInput,
	inheritanceChildren: readonly InheritanceChild[],
	inheritanceBase: InheritanceBase | null,
): {
	pairWrite: boolean;
	upsert: 'own' | 'through_base' | null;
	kindGuardUpdate: boolean;
	kindGuardCreate: boolean;
} {
	const isChild = inheritsOf(definition) !== null;
	let upsert: 'own' | 'through_base' | null = null;
	if (isChild) {
		if (inheritanceBase !== null && inheritanceBase.naturalKeyIndex >= 0) upsert = 'through_base';
	} else if (naturalKeyIndexOf(definition) >= 0) {
		upsert = 'own';
	}
	const hasDiscriminator = typeof definition.discriminator === 'string';
	return {
		pairWrite: isChild,
		upsert,
		kindGuardUpdate: hasDiscriminator,
		kindGuardCreate: hasDiscriminator && inheritanceChildren.length > 0,
	};
}

/** A junction YAML (`pattern: Junction`). */
export interface JunctionInput {
	between: readonly string[];
	expose_on_parent?: { left?: boolean; right?: boolean } | null;
	is_primary?: boolean;
}

/** What `resolvePatternComposition` (`entity-locals.js`) returns — passed in, never re-resolved here. */
export interface PatternCompositionInput {
	patternName: string;
	repositoryBaseClass: string;
	serviceBaseClass: string;
	/** Comma-separated method lists, as the pattern declares them. */
	repositoryInheritedMethods: readonly string[];
	serviceInheritedMethods: readonly string[];
	capabilities: readonly { name: string; forwarderMethods?: readonly string[] }[];
}

export interface EntityApiInput {
	/** The entity's definition. A `roles:` block is merged into `relationships` here (idempotently). */
	definition: EntityDefinitionInput;
	/** Every junction in the project; the ones naming this entity in `between:` fan out onto it. */
	junctions: readonly JunctionInput[];
	composition: PatternCompositionInput;
	/**
	 * The `has_many` targets that will exist once the run finishes (PLAN F3): the render set ∪ what is on disk.
	 * A self-reference is always wired; a target with no YAML never is.
	 */
	wiredTargets: Iterable<string>;
	/**
	 * The entities that `inherits:` THIS one, across the whole set (`inheritanceChildrenOf`). Required, not
	 * defaulted: an absent list would read as "no family" and silently drop a base's cross-kind reads.
	 */
	inheritanceChildren: readonly InheritanceChild[];
	/** The base this entity inherits, with whether that base declares a natural key — `null` for a non-child. */
	inheritanceBase: InheritanceBase | null;
	/**
	 * The kinds this entity's `discriminator:` admits (`discriminatorKindsOf`) — `null` for a non-base. Required, not
	 * defaulted: an unknown list on a base is an error (`createDisabledBy`), never "every kind is base-only".
	 */
	discriminatorKinds: readonly string[] | null;
	/** Another entity's `entity:` block, by name (NAME-0) — `null` when it has no YAML. */
	entityLookup: (name: string) => EntityBlockInput | null;
}

// ============================================================================
// Helpers
// ============================================================================

const TO_ONE = 'belongs_to';
const TO_MANY = 'has_many';

function splitMethodList(lines: readonly string[]): string[] {
	return lines.flatMap((line) =>
		line
			.split(',')
			.map((m) => m.trim())
			.filter(Boolean),
	);
}

function pluralOf(block: EntityBlockInput): string {
	return entityModuleNaming(block, '').plural;
}

// ============================================================================
// The readers other halves share — one each (PLAN §3.2)
// ============================================================================

/**
 * Is this entity's HTTP data plane emitted at all? (ADR-043 §6.) One reader for both forms of the key, so
 * `api: false` and `api: { enabled: false }` cannot diverge — and for both spellings of the input: raw YAML with
 * no `api:` key, and the zod-parsed definition whose default filled it in (§4.3). Absent ⇒ enabled.
 */
export function apiEnabled(def: Pick<EntityDefinitionInput, 'api'>): boolean {
	const api = def.api;
	if (api === false) return false;
	if (typeof api === 'object' && api !== null) return api.enabled !== false;
	return true;
}

// ============================================================================
// The derivation
// ============================================================================

export function deriveEntityApiSurface(input: EntityApiInput): EntityApiSurface {
	const { definition, composition } = input;
	const entityName = definition.entity.name;
	const plural = pluralOf(definition.entity);
	const wired = new Set(input.wiredTargets);

	const ref = (path: YamlPath): YamlRef => ({ doc: { kind: 'entity', name: entityName }, path });
	const fromYaml = (path: YamlPath, shadows: YamlRef[] = []): Origin =>
		shadows.length > 0 ? { from: 'yaml', at: ref(path), shadows } : { from: 'yaml', at: ref(path) };
	const BASE: Origin = { from: 'base' };
	const repoRef = (entity: string, method: string): MethodRef => ({ entity, layer: 'repository', method });
	const serviceRef = (entity: string, method: string): MethodRef => ({ entity, layer: 'service', method });

	// CAP-2 — a `cardinality: one` role IS a belongs_to. Merged exactly as prompt.js merges it, so a definition
	// that arrives already merged comes out the same.
	const relationships = mergedRelationships(definition);
	const relPath = (name: string, rel: RelationshipInput): YamlPath =>
		rel.role ? ['roles', rel.role] : ['relationships', name];

	// REL-2 §2.5 — a `with` exists only when this entity's own table carries an edge (its own, or its family's).
	const typedInclude = hasTypedInclude(definition, input.inheritanceChildren);
	const readOptions: ReadOptionsShape = typedInclude ? 'columns+with' : 'columns';

	const belongsTo = Object.entries(relationships)
		.filter(([, rel]) => rel.type === TO_ONE)
		.map(([name, rel]) => ({ name, rel, foreignKey: rel.foreign_key ?? '', path: relPath(name, rel) }));

	// ── queries: ───────────────────────────────────────────────────────────
	const queries = (definition.queries ?? []).map((q, index) => ({ q, index }));
	const finders = queries
		.filter(({ q }) => q != null && q.by !== undefined)
		.map(({ q, index }) => {
			const by = q.by ?? [];
			const select = q.select ?? [];
			const unique = q.unique ?? false;
			const projection = q.via != null || select.length > 0;
			return { q, index, by, select, unique, projection, name: finderName({ by, select }) };
		});
	const searchQuery = queries.find(({ q }) => q != null && q.name === 'search');
	const hasSearch = searchQuery !== undefined && (searchQuery.q.filters ?? []).length > 0;

	// ── The queries: × belongs_to precedence (repository) ───────────────────
	// A plain, non-unique finder whose name an FK finder also takes loses to the FK finder (it takes `opts`, a
	// superset). A unique / via: / select: finder is the more specific intent and wins over the FK finder.
	const fkNames = new Set(belongsTo.map((b) => fkFinderName(b.foreignKey)));
	const winningFinderNames = new Set(finders.filter((f) => f.unique || f.projection).map((f) => f.name));
	const finderLosesToFk = (f: (typeof finders)[number]) => fkNames.has(f.name) && !f.unique && !f.projection;

	const finderParams = (by: readonly string[]): Param[] => by.map((field) => ({ name: paramName(field), field }));
	const finderReturns = (f: (typeof finders)[number]): Shape =>
		f.unique ? 'one' : f.select.length > 0 ? 'projection' : 'many';

	const repository: RepositoryMethod[] = [
		{
			name: 'findById',
			kind: 'find_by_id',
			emitted: true,
			params: [{ name: 'id' }, { name: 'opts' }],
			returns: 'one',
			readOptions,
			origin: BASE,
		},
		{
			name: 'findByIds',
			kind: 'find_by_ids',
			emitted: true,
			params: [{ name: 'ids' }, { name: 'opts' }],
			returns: 'many',
			readOptions,
			origin: BASE,
		},
		{ name: 'list', kind: 'list', emitted: true, params: [{ name: 'query' }], returns: 'many', readOptions, origin: BASE },
		{ name: 'count', kind: 'count', emitted: true, params: [{ name: 'where' }], returns: 'count', readOptions: 'none', origin: BASE },
	];

	// ── The family reads (RFC-0006 §3, #875) ────────────────────────────────
	const family = familyReadSurface(definition, input.inheritanceChildren);
	const inheritsOrigin = fromYaml([...INHERITS_PATH]);
	// A base's cross-kind reads are caused by its `discriminator:`; the children that make them exist are named.
	const discriminatorOrigin: Origin = {
		from: 'yaml',
		at: {
			...ref(['discriminator']),
			note: `kinds with a child table: ${input.inheritanceChildren.map((c) => c.as).join(', ')}`,
		},
	};
	if (family.child) {
		const baseOf = inheritsOf(definition)!.base;
		repository.push(
			{
				name: FAMILY_METHOD.findWithBase,
				kind: 'with_base',
				emitted: true,
				params: [{ name: 'id' }, { name: 'opts' }],
				returns: 'one',
				readOptions: 'columns+with',
				origin: inheritsOrigin,
			},
			{
				name: FAMILY_METHOD.findManyWithBase,
				kind: 'with_base',
				emitted: true,
				params: [{ name: 'ids' }, { name: 'opts' }],
				returns: 'many',
				readOptions: 'columns+with',
				origin: inheritsOrigin,
			},
			// S5 — what the HTTP list reads: this kind's rows over the base's, flat, filtered and sorted on the base's columns.
			{
				name: FAMILY_METHOD.listFlat,
				kind: 'list_flat',
				delegatesTo: repoRef(baseOf, FAMILY_METHOD.listKind),
				emitted: true,
				params: [{ name: 'query' }, { name: 'opts' }],
				returns: 'many',
				readOptions: 'with',
				origin: inheritsOrigin,
			},
			{
				name: FAMILY_METHOD.countFlat,
				kind: 'count_flat',
				delegatesTo: repoRef(baseOf, FAMILY_METHOD.countKind),
				emitted: true,
				params: [{ name: 'where' }],
				returns: 'count',
				readOptions: 'none',
				origin: inheritsOrigin,
			},
		);
	}
	if (family.crossKind) {
		repository.push(
			{ name: FAMILY_METHOD.findAllKinds, kind: 'all_kinds', emitted: true, params: [{ name: 'query' }], returns: 'many', readOptions: 'none', origin: discriminatorOrigin },
			{ name: FAMILY_METHOD.findKindById, kind: 'kind_by_id', emitted: true, params: [{ name: 'id' }], returns: 'one', readOptions: 'none', origin: discriminatorOrigin },
			{ name: FAMILY_METHOD.listKind, kind: 'list_kind', emitted: true, params: [{ name: 'kind' }, { name: 'query' }, { name: 'childWith' }], returns: 'many', readOptions: 'none', origin: discriminatorOrigin },
			{ name: FAMILY_METHOD.countKind, kind: 'count_kind', emitted: true, params: [{ name: 'kind' }, { name: 'where' }], returns: 'count', readOptions: 'none', origin: discriminatorOrigin },
			{ name: FAMILY_METHOD.findOrphans, kind: 'orphans', emitted: true, params: [{ name: 'opts' }], returns: 'many', readOptions: 'none', origin: discriminatorOrigin },
		);
	}

	// ── The write half (RFC-0006 §4, #875 S4) ───────────────────────────────
	const writeFamily = familyWriteSurface(definition, input.inheritanceChildren, input.inheritanceBase);
	const naturalKeyOrigin = (): Origin => {
		if (writeFamily.upsert === 'through_base' && input.inheritanceBase !== null) {
			return {
				from: 'yaml',
				at: {
					doc: { kind: 'entity', name: input.inheritanceBase.name },
					path: ['unique_indexes', input.inheritanceBase.naturalKeyIndex, 'natural_key'],
					note: `${input.inheritanceBase.name}'s natural key, through ${entityName}'s inherits`,
				},
			};
		}
		return fromYaml(['unique_indexes', naturalKeyIndexOf(definition), 'natural_key']);
	};
	if (writeFamily.pairWrite) {
		repository.push(
			{ name: FAMILY_METHOD.create, kind: 'pair_create', emitted: true, params: [{ name: 'input' }, { name: 'tx' }], returns: 'one', readOptions: 'none', origin: inheritsOrigin },
			{ name: FAMILY_METHOD.update, kind: 'pair_update', emitted: true, params: [{ name: 'id' }, { name: 'patch' }, { name: 'tx' }], returns: 'one', readOptions: 'none', origin: inheritsOrigin },
			{ name: FAMILY_METHOD.delete, kind: 'pair_delete', emitted: true, params: [{ name: 'id' }, { name: 'tx' }], returns: 'none', readOptions: 'none', origin: inheritsOrigin },
		);
	}
	if (writeFamily.kindGuardUpdate) {
		repository.push({
			name: FAMILY_METHOD.update,
			kind: 'kind_guard',
			emitted: true,
			params: [{ name: 'id' }, { name: 'input' }, { name: 'tx' }],
			returns: 'one',
			readOptions: 'none',
			origin: fromYaml(['discriminator']),
		});
	}
	if (writeFamily.kindGuardCreate) {
		// `create` itself is BaseRepository's — the guard overrides it, and a child's own pair write passes `via`.
		repository.push({
			name: FAMILY_METHOD.create,
			kind: 'create_guard',
			emitted: true,
			params: [{ name: 'input' }, { name: 'tx' }, { name: 'via' }],
			returns: 'one',
			readOptions: 'none',
			origin: fromYaml(['discriminator']),
		});
	}
	if (writeFamily.upsert !== null) {
		repository.push({
			name: FAMILY_METHOD.upsertByNaturalKey,
			kind: writeFamily.upsert === 'own' ? 'upsert_own' : 'upsert_through_base',
			emitted: true,
			params: writeFamily.upsert === 'own' && writeFamily.kindGuardCreate ? [{ name: 'input' }, { name: 'tx' }, { name: 'via' }] : [{ name: 'input' }, { name: 'tx' }],
			returns: 'one',
			readOptions: 'none',
			origin: naturalKeyOrigin(),
		});
	}

	for (const f of finders) {
		if (finderLosesToFk(f)) continue;
		const shadows = belongsTo.filter((b) => fkFinderName(b.foreignKey) === f.name).map((b) => ref(b.path));
		const method: RepositoryMethod = {
			name: f.name,
			kind: f.projection ? 'finder_projection' : 'finder',
			emitted: true,
			params: f.projection ? finderParams(f.by) : [...finderParams(f.by), { name: 'opts' }],
			returns: finderReturns(f),
			readOptions: f.projection ? 'none' : readOptions,
			origin: fromYaml(['queries', f.index], shadows),
		};
		if (f.unique) method.unique = true;
		const order = parseOrder(f.q.order);
		if (order) method.order = order;
		repository.push(method);
	}

	for (const b of belongsTo) {
		const name = fkFinderName(b.foreignKey);
		if (winningFinderNames.has(name)) continue;
		const shadows = finders.filter((f) => f.name === name && finderLosesToFk(f)).map((f) => ref(['queries', f.index]));
		repository.push({
			name,
			kind: 'fk_finder',
			emitted: true,
			params: [{ name: 'id', field: b.foreignKey }, { name: 'opts' }],
			returns: 'many',
			readOptions,
			limit: true,
			origin: fromYaml(b.path, shadows),
		});
	}

	if (definition.eav_value_table === true) {
		repository.push({
			name: 'upsertCurrentValues',
			kind: 'eav_upsert',
			emitted: true,
			params: [{ name: 'inputs' }, { name: 'tx' }],
			returns: 'many',
			readOptions: 'none',
			origin: fromYaml(['eav_value_table']),
		});
	}

	const emittedRepository = new Set(repository.map((m) => m.name));
	for (const name of splitMethodList(composition.repositoryInheritedMethods)) {
		if (emittedRepository.has(name)) continue;
		emittedRepository.add(name);
		repository.push(inherited(name, { from: 'pattern', pattern: composition.patternName }));
	}
	// A capability's forwarded methods live on its repository mixin (ADR-041).
	for (const cap of composition.capabilities) {
		for (const name of cap.forwarderMethods ?? []) {
			if (emittedRepository.has(name)) continue;
			emittedRepository.add(name);
			repository.push(inherited(name, { from: 'capability', capability: cap.name }));
		}
	}

	// ── Service ─────────────────────────────────────────────────────────────
	const service: ServiceMethod[] = [
		{
			name: 'findById',
			kind: 'read',
			emitted: true,
			params: [{ name: 'id' }, { name: 'opts' }],
			returns: 'one',
			delegatesTo: repoRef(entityName, 'findById'),
			origin: BASE,
		},
		{
			name: 'findByIds',
			kind: 'read',
			emitted: true,
			params: [{ name: 'ids' }, { name: 'opts' }],
			returns: 'many',
			delegatesTo: repoRef(entityName, 'findByIds'),
			origin: BASE,
		},
		{
			name: 'list',
			kind: 'read',
			emitted: true,
			params: [{ name: 'listOptions' }],
			returns: 'many',
			delegatesTo: repoRef(entityName, 'list'),
			origin: BASE,
		},
	];

	// The family reads, forwarded verbatim — right after the core reads, as the repository has them (same names, same params, the repository's result).
	for (const m of repository) {
		if (!isFamilyReadKind(m.kind)) continue;
		service.push({
			name: m.name,
			kind: m.kind,
			emitted: true,
			params: m.params,
			returns: m.returns,
			delegatesTo: repoRef(entityName, m.name),
			origin: m.origin,
		});
	}

	// The write half, forwarded: a child's pair write, the upsert. A base's create guard is the repository's.
	if (writeFamily.pairWrite) {
		service.push(
			{ name: FAMILY_METHOD.create, kind: 'pair_create', emitted: true, params: [{ name: 'input' }, { name: 'tx' }], returns: 'one', delegatesTo: repoRef(entityName, FAMILY_METHOD.create), origin: inheritsOrigin },
			{ name: FAMILY_METHOD.update, kind: 'pair_update', emitted: true, params: [{ name: 'id' }, { name: 'patch' }, { name: 'tx' }], returns: 'one', delegatesTo: repoRef(entityName, FAMILY_METHOD.update), origin: inheritsOrigin },
			{ name: FAMILY_METHOD.delete, kind: 'pair_delete', emitted: true, params: [{ name: 'id' }, { name: 'tx' }], returns: 'none', delegatesTo: repoRef(entityName, FAMILY_METHOD.delete), origin: inheritsOrigin },
		);
	}
	if (writeFamily.upsert !== null) {
		service.push({
			name: FAMILY_METHOD.upsertByNaturalKey,
			kind: writeFamily.upsert === 'own' ? 'upsert_own' : 'upsert_through_base',
			emitted: true,
			params: [{ name: 'input' }, { name: 'tx' }],
			returns: 'one',
			delegatesTo: repoRef(entityName, FAMILY_METHOD.upsertByNaturalKey),
			origin: naturalKeyOrigin(),
		});
	}

	// Every finder is forwarded — the service applies no precedence skip; a forwarder whose finder lost to an
	// FK finder calls the FK finder of the same name.
	for (const f of finders) {
		service.push({
			name: f.name,
			kind: 'finder',
			emitted: true,
			params: f.projection ? finderParams(f.by) : [...finderParams(f.by), { name: 'opts' }],
			returns: finderReturns(f),
			delegatesTo: repoRef(entityName, f.name),
			origin: fromYaml(['queries', f.index]),
		});
	}

	for (const cap of composition.capabilities) {
		for (const name of cap.forwarderMethods ?? []) {
			service.push({
				name,
				kind: 'capability_forwarder',
				emitted: true,
				params: [{ name: '...args' }],
				returns: 'forwarded',
				delegatesTo: repoRef(entityName, name),
				origin: { from: 'capability', capability: cap.name },
			});
		}
	}

	const selfIdParam = idParamName(entityName);
	for (const b of belongsTo) {
		const isSelf = b.rel.target === entityName;
		service.push({
			name: relationMethodName({
				cardinality: 'one',
				name: b.name,
				role: b.rel.role,
				foreignKey: b.foreignKey,
				isSelf,
			}),
			kind: 'relation_one',
			emitted: true,
			params: [{ name: selfIdParam }],
			returns: 'one',
			delegatesTo: repoRef(isSelf ? entityName : b.rel.target, 'findById'),
			origin: fromYaml(b.path),
		});
	}

	for (const [name, rel] of Object.entries(relationships)) {
		if (rel.type !== TO_MANY) continue;
		const isSelf = rel.target === entityName;
		const isWired = isSelf || (input.entityLookup(rel.target) !== null && wired.has(rel.target));
		if (!isWired) continue;
		const foreignKey = rel.foreign_key ?? '';
		service.push({
			name: relationMethodName({ cardinality: 'many', name, foreignKey, isSelf }),
			kind: 'relation_many',
			emitted: true,
			params: [{ name: selfIdParam }, { name: 'opts' }],
			returns: 'many',
			delegatesTo: repoRef(isSelf ? entityName : rel.target, fkFinderName(foreignKey)),
			origin: fromYaml(relPath(name, rel)),
		});
	}

	for (const fan of junctionFanOut(entityName, input)) {
		const at: YamlRef = { doc: { kind: 'junction', name: fan.junction }, path: ['between', fan.side === 'left' ? 0 : 1] };
		const origin: Origin = { from: 'yaml', at };
		const counterpartyIdParam = idParamName(fan.counterparty);
		service.push(
			{
				name: junctionAttachName(fan.side, fan.counterparty),
				kind: 'junction_attach',
				emitted: true,
				params: [{ name: selfIdParam }, { name: counterpartyIdParam }, { name: 'link' }],
				returns: 'one',
				delegatesTo: serviceRef(fan.junction, 'attach'),
				origin,
			},
			{
				name: junctionDetachName(fan.side, fan.counterparty),
				kind: 'junction_detach',
				emitted: true,
				params: [{ name: selfIdParam }, { name: counterpartyIdParam }],
				returns: 'none',
				delegatesTo: serviceRef(fan.junction, 'detach'),
				origin,
			},
			{
				name: junctionListName(fan.counterpartyPlural),
				kind: 'junction_list',
				emitted: true,
				params: [{ name: selfIdParam }, { name: 'opts' }],
				returns: 'many',
				delegatesTo: serviceRef(fan.junction, 'listAssoc'),
				origin,
			},
		);
		if (fan.hasIsPrimary) {
			service.push({
				name: junctionSetPrimaryName(fan.counterpartyPlural),
				kind: 'junction_set_primary',
				emitted: true,
				params: [{ name: selfIdParam }, { name: counterpartyIdParam }],
				returns: 'none',
				delegatesTo: serviceRef(fan.junction, 'setPrimary'),
				origin,
			});
		}
	}

	const eav = definition.eav === true;
	const eavValueTable = definition.eav_value_table === true;
	if (eav) {
		const origin = fromYaml(['eav']);
		service.push(
			{
				name: 'findByIdWithFields',
				kind: 'eav_read',
				emitted: true,
				params: [{ name: 'id' }],
				returns: 'one',
				delegatesTo: repoRef(entityName, 'findById'),
				origin,
			},
			{
				name: 'listWithFields',
				kind: 'eav_read',
				emitted: true,
				params: [],
				returns: 'many',
				delegatesTo: repoRef(entityName, 'list'),
				origin,
			},
		);
	}
	if (eavValueTable) {
		const origin = fromYaml(['eav_value_table']);
		service.push(
			{
				name: 'upsertFieldsTransactional',
				kind: 'eav_write',
				emitted: true,
				params: [{ name: 'entityType' }, { name: 'entityId' }, { name: 'userId' }, { name: 'fields' }, { name: 'tx' }],
				returns: 'none',
				delegatesTo: repoRef(entityName, 'upsertCurrentValues'),
				origin,
			},
			{
				name: 'findMergedByEntity',
				kind: 'eav_read',
				emitted: true,
				params: [{ name: 'entityType' }, { name: 'entityId' }],
				returns: 'one',
				delegatesTo: repoRef(entityName, 'findByEntityIdAndType'),
				origin,
			},
		);
	}

	const emittedService = new Set(service.map((m) => m.name));
	for (const name of splitMethodList(composition.serviceInheritedMethods)) {
		if (emittedService.has(name)) continue;
		emittedService.add(name);
		service.push({
			name,
			kind: 'inherited',
			emitted: false,
			params: [],
			returns: 'forwarded',
			origin: { from: 'pattern', pattern: composition.patternName },
		});
	}

	// ── Use cases ───────────────────────────────────────────────────────────
	const writesOff = writesDisabledBy({ entity: definition.entity, generate: definition.generate });
	const generateWrites = writesOff === null;
	// A base whose every kind has a child table has no create of its own (RFC-0006 §4.1, S5).
	const createOff = generateWrites ? createDisabledBy(definition, input.inheritanceChildren, input.discriminatorKinds) : null;
	const generateCreate = generateWrites && createOff === null;
	const useCases: UseCase[] = [
		{
			className: useCaseClassName('find_by_id', entityName, plural),
			kind: 'find_by_id',
			// A child is read FLAT, through its base row (RFC-0006 §3.2, S5).
			calls: serviceRef(entityName, family.child ? FAMILY_METHOD.findWithBase : 'findById'),
			origin: BASE,
		},
		{
			className: useCaseClassName('list', entityName, plural),
			kind: 'list',
			calls: serviceRef(entityName, 'list'),
			// A child's list has two roots (S5): base-rooted by default (`listFlat` / `countFlat`), child-rooted
			// (`list` / `count`) for a child-column sort or a filter. Both paths are named.
			...(family.child
				? {
						alsoCalls: [
							serviceRef(entityName, 'count'),
							serviceRef(entityName, FAMILY_METHOD.listFlat),
							serviceRef(entityName, FAMILY_METHOD.countFlat),
						],
					}
				: {}),
			origin: BASE,
		},
	];
	if (eav) {
		const origin = fromYaml(['eav']);
		useCases.push(
			{
				className: useCaseClassName('find_by_id_with_fields', entityName, plural),
				kind: 'find_by_id_with_fields',
				calls: serviceRef(entityName, 'findByIdWithFields'),
				origin,
			},
			{
				className: useCaseClassName('list_with_fields', entityName, plural),
				kind: 'list_with_fields',
				calls: serviceRef(entityName, 'listWithFields'),
				origin,
			},
		);
	}
	if (generateWrites) {
		for (const [kind, method] of [
			['create', 'create'],
			['update', 'update'],
			['delete', 'delete'],
		] as const) {
			if (kind === 'create' && !generateCreate) continue;
			useCases.push({
				className: useCaseClassName(kind, entityName, plural),
				kind,
				calls: serviceRef(entityName, method),
				// A delete that publishes `<entity>_deleted` reads the row first, because the payload reads it; a child
				// reads the flat row, since the payload reads base fields too (RFC-0006 §5). A delete with no event
				// makes no such read, so none is recorded.
				...(kind === 'delete' && publishedWriteEvent(entityName, kind, definition.emits) !== null
					? { preRead: serviceRef(entityName, family.child ? FAMILY_METHOD.findWithBase : 'findById') }
					: {}),
				origin: BASE,
			});
		}
	}
	for (const f of finders) {
		useCases.push({
			className: queryUseCaseClassName(f.name, entityName),
			kind: 'query',
			calls: serviceRef(entityName, f.name),
			origin: fromYaml(['queries', f.index]),
		});
	}
	if (hasSearch && searchQuery) {
		useCases.push({
			className: useCaseClassName('search', entityName, plural),
			kind: 'search',
			// A search ANDs its filters into a `where` and pages through the list use case, so it reaches the
			// service's `list` (#744).
			calls: serviceRef(entityName, 'list'),
			origin: fromYaml(['queries', searchQuery.index]),
		});
	}

	// ── HTTP ────────────────────────────────────────────────────────────────
	const api = definition.api;
	const apiBlock = typeof api === 'object' && api !== null ? api : null;
	const enabled = apiEnabled(definition);
	const disabledBy: YamlRef | undefined =
		api === false ? ref(['api']) : apiBlock && apiBlock.enabled === false ? ref(['api', 'enabled']) : undefined;
	const includeRoutes = apiBlock?.includes ? Object.keys(apiBlock.includes) : [];
	const includeRoute = (key: 'list' | 'find_by_id') =>
		typedInclude && includeRoutes.includes(key) ? { includeRoute: key } : {};

	const routes: Route[] = [];
	if (enabled) {
		const controller = controllerClassName(entityName);
		const crud = (
			verb: Route['verb'],
			subPath: string | undefined,
			handler: string,
			op: Parameters<typeof operationId>[0],
			useCase: string,
			origin: Origin,
			extra: Partial<Route> = {},
		): Route => ({
			verb,
			path: routePath(plural, subPath),
			controller,
			handler,
			operationId: operationId(op, entityName),
			useCase,
			...extra,
			origin,
		});
		const eavOrigin = fromYaml(['eav']);
		routes.push(
			crud('GET', undefined, 'getAll', 'list', useCaseClassName('list', entityName, plural), BASE, includeRoute('list')),
		);
		if (eav) {
			routes.push(
				crud(
					'GET',
					'with-fields',
					'getAllWithFields',
					'list_with_fields',
					useCaseClassName('list_with_fields', entityName, plural),
					eavOrigin,
				),
			);
		}
		routes.push(
			crud(
				'GET',
				':id',
				'getById',
				'find_by_id',
				useCaseClassName('find_by_id', entityName, plural),
				BASE,
				includeRoute('find_by_id'),
			),
		);
		if (eav) {
			routes.push(
				crud(
					'GET',
					':id/with-fields',
					'getByIdWithFields',
					'find_by_id_with_fields',
					useCaseClassName('find_by_id_with_fields', entityName, plural),
					eavOrigin,
				),
			);
		}
		if (generateWrites) {
			if (generateCreate) {
				routes.push(crud('POST', undefined, 'create', 'create', useCaseClassName('create', entityName, plural), BASE));
			}
			routes.push(
				crud('PATCH', ':id', 'update', 'update', useCaseClassName('update', entityName, plural), BASE),
				crud('DELETE', ':id', 'remove', 'delete', useCaseClassName('delete', entityName, plural), BASE),
			);
		}
		if (hasSearch && searchQuery) {
			routes.push({
				verb: 'GET',
				path: routePath(plural, 'search'),
				controller: searchControllerClassName(entityName),
				handler: 'search',
				// The Nest controller names no operationId, so Nest's document uses `<Controller>_<handler>` (H-1b2).
				operationId: nestDefaultOperationId(searchControllerClassName(entityName), 'search'),
				useCase: useCaseClassName('search', entityName, plural),
				origin: fromYaml(['queries', searchQuery.index]),
			});
		}
	}

	const commandsOff = commandsDisabledBy({ generate: definition.generate });
	const commands = commandsOff ? [] : deriveCommands(entityName, plural, useCases, routes, includeRoute);

	const http: EntityApiSurface['http'] = {
		enabled,
		routes,
		includeRoutes,
		includesConst: includesConstName(plural),
		...(routesOn(definition)
			? { routesFunction: routesFunctionName(entityName), registerPathsFunction: registerPathsName(entityName) }
			: {}),
	};
	if (disabledBy) http.disabledBy = disabledBy;

	return {
		entity: entityName,
		plural,
		className: entityClassName(entityName),
		repository: {
			className: repositoryClassName(entityName),
			baseClass: composition.repositoryBaseClass,
			typedInclude,
			methods: repository,
		},
		service: { className: serviceClassName(entityName), baseClass: composition.serviceBaseClass, methods: service },
		useCases,
		commands,
		commandsConst: commandsConstName(entityName),
		notFoundMessage: notFoundMessage(entityName),
		http,
		// Recorded only when writes are off, so an entity that emits them carries no new key.
		...(writesOff ? { writesDisabledBy: ref(writesOff) } : {}),
		// Recorded only when commands are off (ID-1: identity's entities), so an entity that has them carries no new key.
		...(commandsOff ? { commandsDisabledBy: ref(commandsOff) } : {}),
		// Recorded only for a base with no create of its own; the note names the kinds that all have a child table.
		...(createOff
			? {
					createDisabledBy: {
						...ref(createOff),
						note: `every kind has a child table: ${input.inheritanceChildren.map((c) => c.as).join(', ')}`,
					},
				}
			: {}),
	};
}

/**
 * One command per use case but a declarative query (H-1): its name, effect and flat input, and, when routed, how a
 * request carries that input. The include is always part of a find's and a list's input, so a way in that passes one
 * where nothing is allowlisted is refused, as the Nest controller refuses `?include=` on such a route.
 */
export function deriveCommands(
	entityName: string,
	plural: string,
	useCases: readonly UseCase[],
	routes: readonly Route[],
	includeRoute: (key: 'list' | 'find_by_id') => { includeRoute?: 'list' | 'find_by_id' },
): EntityCommand[] {
	const commands: EntityCommand[] = [];
	for (const u of useCases) {
		if (u.kind === 'query') continue;
		const kind = u.kind;
		const route = routes.find((r) => r.useCase === u.className);
		const shape = COMMAND_SHAPES[kind];
		commands.push({
			name: commandName(kind, entityName),
			summary: shape.summary(entityName, plural),
			useCase: u.className,
			kind,
			useCaseKey: useCaseKey(kind),
			effect: shape.effect,
			input: shape.input,
			...(shape.includeKey ? includeRoute(shape.includeKey) : {}),
			...(route
				? { http: { verb: route.verb, path: route.path, binding: shape.binding, success: NEST_SUCCESS_STATUS[route.verb] } }
				: {}),
			origin: u.origin,
		});
	}
	return commands;
}


/**
 * Each use case kind's command: its summary, effect and input; the `api.includes` key its include resolves against;
 * and how an HTTP request carries the input (the path, the query — `'all'` for a list or search — and the body).
 * The Nest controller prints its `@ApiOperation` summaries from the same rows.
 */
const COMMAND_SHAPES: Readonly<
	Record<
		EntityCommand['kind'],
		{
			summary: (entityName: string, plural: string) => string;
			effect: EntityCommand['effect'];
			input: EntityCommand['input'];
			includeKey?: 'list' | 'find_by_id';
			binding: NonNullable<EntityCommand['http']>['binding'];
		}
	>
> = {
	list: {
		summary: (_e, p) => `List ${p}`,
		effect: 'read',
		input: { id: false, include: true, query: 'list' },
		includeKey: 'list',
		binding: { path: [], query: 'all', body: false },
	},
	find_by_id: {
		summary: (e) => `Find ${e} by id`,
		effect: 'read',
		input: { id: true, include: true },
		includeKey: 'find_by_id',
		binding: { path: ['id'], query: ['include'], body: false },
	},
	list_with_fields: {
		summary: (_e, p) => `List ${p} with EAV fields`,
		effect: 'read',
		input: { id: false, include: false },
		binding: { path: [], query: [], body: false },
	},
	find_by_id_with_fields: {
		summary: (e) => `Find ${e} with EAV fields`,
		effect: 'read',
		input: { id: true, include: false },
		binding: { path: ['id'], query: [], body: false },
	},
	search: {
		summary: (_e, p) => `Search ${p}`,
		effect: 'read',
		input: { id: false, include: false, query: 'search' },
		binding: { path: [], query: 'all', body: false },
	},
	create: {
		summary: (e) => `Create ${e}`,
		effect: 'side-effect',
		input: { id: false, include: false, dto: 'create' },
		binding: { path: [], query: [], body: true },
	},
	update: {
		summary: (e) => `Update ${e}`,
		effect: 'idempotent',
		input: { id: true, include: false, dto: 'update' },
		binding: { path: ['id'], query: [], body: true },
	},
	delete: {
		summary: (e) => `Delete ${e}`,
		effect: 'side-effect',
		input: { id: true, include: false },
		binding: { path: ['id'], query: [], body: false },
	},
};

function inherited(name: string, origin: Origin): RepositoryMethod {
	return { name, kind: 'inherited', emitted: false, params: [], returns: 'forwarded', readOptions: 'none', origin };
}

/** `created_at desc` → `{ column: 'created_at', direction: 'desc' }`; no direction is ascending. */
function parseOrder(order: string | undefined): RepositoryMethod['order'] | undefined {
	if (order == null) return undefined;
	const [column, direction] = order.trim().split(/\s+/);
	if (!column) return undefined;
	return { column, direction: direction === 'desc' ? 'desc' : 'asc' };
}

interface FanOut {
	junction: string;
	side: JunctionSide;
	counterparty: string;
	counterpartyPlural: string;
	hasIsPrimary: boolean;
}

/**
 * The junctions mirrored onto this entity's service (JUNC-0): one per junction naming it in `between:` whose
 * side is exposed (`expose_on_parent.<side>`, default true), in junction-name order.
 */
function junctionFanOut(entityName: string, input: EntityApiInput): FanOut[] {
	const fans: FanOut[] = [];
	const sorted = [...input.junctions]
		.filter((j) => j.between.length === 2)
		.map((j) => ({ j, name: junctionName([j.between[0] ?? '', j.between[1] ?? '']) }))
		.sort((a, b) => a.name.localeCompare(b.name));
	for (const { j, name } of sorted) {
		const [left, right] = [j.between[0] ?? '', j.between[1] ?? ''];
		if (left !== entityName && right !== entityName) continue;
		const side: JunctionSide = left === entityName ? 'left' : 'right';
		if (j.expose_on_parent?.[side] === false) continue;
		const counterparty = side === 'left' ? right : left;
		const block = input.entityLookup(counterparty);
		if (!block) {
			throw new Error(`[codegen] junction '${name}': endpoint '${counterparty}' has no entity YAML.`);
		}
		fans.push({
			junction: name,
			side,
			counterparty,
			counterpartyPlural: pluralOf(block),
			hasIsPrimary: j.is_primary !== false,
		});
	}
	return fans;
}
