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

import { entityModuleNaming } from '../../config/module-tree.js';
import { junctionName } from '../../config/junction-naming.js';
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
	paramName,
	queryUseCaseClassName,
	relationMethodName,
	repositoryClassName,
	routePath,
	searchControllerClassName,
	serviceClassName,
	useCaseClassName,
	type JunctionSide,
} from './names.js';
import type {
	EntityApiSurface,
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
	generate?: { writes?: boolean } | null;
	eav?: boolean;
	eav_value_table?: boolean;
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
	const relationships: Record<string, RelationshipInput> = {
		...(definition.relationships ?? {}),
		...deriveRoleRelationships(definition.roles ?? undefined),
	};
	const relPath = (name: string, rel: RelationshipInput): YamlPath =>
		rel.role ? ['roles', rel.role] : ['relationships', name];

	// REL-2 §2.5 — a `with` exists only when this entity's own table carries an edge.
	const typedInclude = Object.values(relationships).some((rel) => !rel.through);
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
	const generateWrites = definition.generate?.writes !== false;
	const useCases: UseCase[] = [
		{
			className: useCaseClassName('find_by_id', entityName, plural),
			kind: 'find_by_id',
			calls: serviceRef(entityName, 'findById'),
			origin: BASE,
		},
		{ className: useCaseClassName('list', entityName, plural), kind: 'list', calls: serviceRef(entityName, 'list'), origin: BASE },
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
			useCases.push({
				className: useCaseClassName(kind, entityName, plural),
				kind,
				calls: serviceRef(entityName, method),
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
	const enabled = api === false ? false : apiBlock ? apiBlock.enabled !== false : true;
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
			routes.push(
				crud('POST', undefined, 'create', 'create', useCaseClassName('create', entityName, plural), BASE),
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
				useCase: useCaseClassName('search', entityName, plural),
				origin: fromYaml(['queries', searchQuery.index]),
			});
		}
	}

	const http: EntityApiSurface['http'] = { enabled, routes, includeRoutes, includesConst: includesConstName(plural) };
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
		http,
	};
}

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
