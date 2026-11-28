/**
 * Every name the generated backend API surface carries — one rule each, as a named export (ADR-046).
 *
 * Each rule reproduces what the backend templates emit TODAY, oddities included (PLAN §3.4): a to-many relation
 * method and a non-self `belongs_to` method carry the raw YAML name, `operationId` pluralises by appending `s`,
 * and the controller prefix is the raw `plural:`. Byte identity is Phase B's gate; this module already agrees.
 *
 * Hygen-safe: `entity-locals.js` will import this module (ADR-046 Phase B), so it imports only modules that
 * ship in the package's `files`. The case primitive is `src/config/file-naming.ts`'s — never a local copy.
 */

import { camelCase, emittedStem } from '../../config/file-naming.js';

/** `deal_state` → `DealState`. */
export function pascalCase(name: string): string {
	const camel = camelCase(name);
	return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/** A YAML column as a TypeScript parameter / property name: `account_id` → `accountId`. */
export function paramName(field: string): string {
	return camelCase(field);
}

/** The id parameter naming one entity: `deal_state` → `dealStateId`. */
export function idParamName(entityName: string): string {
	return `${camelCase(entityName)}Id`;
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

export function entityClassName(entityName: string): string {
	return pascalCase(entityName);
}

/**
 * The database type name and the exported const of an enum field — namespaced by the OWNING entity so two entities'
 * same-named enums never collide (`communication_kind` / `communicationKindEnum`). `deriveFieldFacts` and every
 * importer of an enum read this one rule. A name only: what declares the enum is the target's renderer.
 */
export function enumTypeNames(entityName: string, fieldName: string): { dbName: string; enumName: string } {
	const dbName = entityName ? `${entityName}_${fieldName}` : fieldName;
	return { dbName, enumName: `${camelCase(dbName)}Enum` };
}

/**
 * The Zod schema names a module's DTO files export, and the file stem of each (no folder, no extension) — the one
 * owner of both, so a child's import of its base's schema and the base's own export cannot drift (RFC-0006 §5).
 */
export function dtoSchemaNames(entityName: string): {
	createSchema: string;
	updateSchema: string;
	outputSchema: string;
	ownOutputSchema: string;
	ofKindSchema: string;
} {
	const c = entityClassName(entityName);
	return {
		createSchema: `Create${c}Schema`,
		updateSchema: `Update${c}Schema`,
		outputSchema: `${c}OutputSchema`,
		ownOutputSchema: `${c}OwnOutputSchema`,
		ofKindSchema: `${c}OfKindSchema`,
	};
}

export function dtoFileStem(entityName: string, kind: 'create' | 'update' | 'output' | 'ofKind'): string {
	switch (kind) {
		case 'create':
			return emittedStem('create', entityName);
		case 'update':
			return emittedStem('update', entityName);
		case 'output':
			return emittedStem(entityName, 'output');
		case 'ofKind':
			return emittedStem(entityName, 'of-kind');
	}
}

export function repositoryClassName(entityName: string): string {
	return `${pascalCase(entityName)}Repository`;
}

export function serviceClassName(entityName: string): string {
	return `${pascalCase(entityName)}Service`;
}

/** A module's class: the table export's plural, PascalCased — `deal_states` → `DealStatesModule`. */
export function moduleClassName(plural: string): string {
	return `${pascalCase(plural)}Module`;
}

export function controllerClassName(entityName: string): string {
	return `${pascalCase(entityName)}Controller`;
}

export function searchControllerClassName(entityName: string): string {
	return `${pascalCase(entityName)}SearchController`;
}

/** The use-case kinds whose class name is fixed by the entity alone. */
export type FixedUseCaseKind =
	| 'find_by_id'
	| 'list'
	| 'create'
	| 'update'
	| 'delete'
	| 'find_by_id_with_fields'
	| 'list_with_fields'
	| 'search';

/**
 * A use case's class name. The singular kinds name the entity (`FindDealStateByIdUseCase`), the list kinds its
 * plural (`ListDealStatesUseCase`, `SearchDealsUseCase`).
 */
export function useCaseClassName(kind: FixedUseCaseKind, entityName: string, plural: string): string {
	const e = pascalCase(entityName);
	const p = pascalCase(plural);
	switch (kind) {
		case 'find_by_id':
			return `Find${e}ByIdUseCase`;
		case 'list':
			return `List${p}UseCase`;
		case 'create':
			return `Create${e}UseCase`;
		case 'update':
			return `Update${e}UseCase`;
		case 'delete':
			return `Delete${e}UseCase`;
		case 'find_by_id_with_fields':
			return `Find${e}ByIdWithFieldsUseCase`;
		case 'list_with_fields':
			return `List${p}WithFieldsUseCase`;
		case 'search':
			return `Search${p}UseCase`;
	}
}

/**
 * A `queries:` finder's use-case class: the finder name with the entity spliced in after `Find`, so two
 * entities' `findByName` stay distinct — `findByDomain` on `account` → `FindAccountByDomainUseCase`.
 */
export function queryUseCaseClassName(finder: string, entityName: string): string {
	return `${pascalCase(finder).replace(/^Find/, `Find${pascalCase(entityName)}`)}UseCase`;
}

// ---------------------------------------------------------------------------
// Repository finders
// ---------------------------------------------------------------------------

/** The two halves of a `queries:` entry that name its finder. */
export interface FinderNameInput {
	by?: readonly string[] | null;
	select?: readonly string[] | null;
}

/**
 * A `queries:` finder: `findBy` + the `by:` columns joined by `And`; with a `select:` projection the picked
 * fields come first, pluralised by appending `s` — `findEmailsByOpportunityId`.
 */
export function finderName(query: FinderNameInput): string {
	const byPart = (query.by ?? []).map(pascalCase).join('And');
	const select = query.select ?? [];
	if (select.length > 0) return `find${select.map(pascalCase).join('And')}sBy${byPart}`;
	return `findBy${byPart}`;
}

/** A `belongs_to`'s FK-traversal finder, from its foreign key: `account_id` → `findByAccountId`. */
export function fkFinderName(foreignKey: string): string {
	return `findBy${pascalCase(foreignKey)}`;
}

// ---------------------------------------------------------------------------
// Service relation methods
// ---------------------------------------------------------------------------

export interface RelationMethodNameInput {
	/** `one` for a `belongs_to` (or a `cardinality: one` role), `many` for a `has_many`. */
	cardinality: 'one' | 'many';
	/** The relationship's YAML key. */
	name: string;
	/** The role that derived it, when a role did. */
	role?: string | null;
	foreignKey: string;
	/** The relationship targets its own entity. */
	isSelf: boolean;
}

/**
 * The service's relation method.
 *
 * - to-many: the YAML key, verbatim (#697 — not camel-cased).
 * - to-one from a role: the role, camel-cased.
 * - to-one onto self: the FK column without `_id`, camel-cased (`parent_account_id` → `parentAccount`), so it
 *   cannot collide with the entity's own name.
 * - any other to-one: the YAML key, verbatim (#731 — two edges onto one target are two methods).
 */
export function relationMethodName(rel: RelationMethodNameInput): string {
	if (rel.cardinality === 'many') return rel.name;
	if (rel.role) return camelCase(rel.role);
	if (rel.isSelf) {
		const base = rel.foreignKey.endsWith('_id') ? rel.foreignKey.slice(0, -3) : rel.foreignKey;
		return camelCase(base);
	}
	return rel.name;
}

// ---------------------------------------------------------------------------
// Junction fan-out (JUNC-0) — the methods a junction mirrors onto each parent
// ---------------------------------------------------------------------------

export type JunctionSide = 'left' | 'right';

/** `attach<Counterparty>` on the left parent, `addTo<Counterparty>` on the right. */
export function junctionAttachName(side: JunctionSide, counterparty: string): string {
	return side === 'left' ? `attach${pascalCase(counterparty)}` : `addTo${pascalCase(counterparty)}`;
}

/** `detach<Counterparty>` on the left parent, `removeFrom<Counterparty>` on the right. */
export function junctionDetachName(side: JunctionSide, counterparty: string): string {
	return side === 'left' ? `detach${pascalCase(counterparty)}` : `removeFrom${pascalCase(counterparty)}`;
}

/** `<counterparty plural>List` — the raw plural (#697). */
export function junctionListName(counterpartyPlural: string): string {
	return `${counterpartyPlural}List`;
}

/** `<counterparty plural>SetPrimary` — the raw plural (#697). */
export function junctionSetPrimaryName(counterpartyPlural: string): string {
	return `${counterpartyPlural}SetPrimary`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** The controller prefix: the raw `plural:` (`deal_states`), not its kebab form. */
export function controllerPrefix(plural: string): string {
	return plural;
}

/** A route path: `/` + the controller prefix, then the handler's sub-path when it has one. */
export function routePath(plural: string, subPath?: string): string {
	const prefix = `/${controllerPrefix(plural)}`;
	return subPath ? `${prefix}/${subPath}` : prefix;
}

/** The route kinds that carry an `operationId`. */
export type OperationKind = 'list' | 'list_with_fields' | 'find_by_id' | 'find_by_id_with_fields' | 'create' | 'update' | 'delete';

/** `list<Entity>s` — the list operations pluralise by appending `s`, not from `plural:` (PLAN §3.4). */
export function operationId(kind: OperationKind, entityName: string): string {
	const e = pascalCase(entityName);
	switch (kind) {
		case 'list':
			return `list${e}s`;
		case 'list_with_fields':
			return `list${e}sWithFields`;
		case 'find_by_id':
			return `find${e}ById`;
		case 'find_by_id_with_fields':
			return `find${e}ByIdWithFields`;
		case 'create':
			return `create${e}`;
		case 'update':
			return `update${e}`;
		case 'delete':
			return `delete${e}`;
	}
}

/** The HTTP include allowlist constant, keyed off the table export: `deal_states` → `DEAL_STATES_API_INCLUDES`. */
export function includesConstName(plural: string): string {
	return `${plural.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}_API_INCLUDES`;
}

/**
 * A generated module-level constant of one entity, `<ENTITY>_<SUFFIX>` (`meeting` + `BASE_KEYS` → `MEETING_BASE_KEYS`).
 * The one SCREAMING_CASE rule, shared with `includesConstName`: a camelCase boundary is a word break.
 */
export function familyConstName(entityName: string, suffix: string): string {
	return `${entityName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_${suffix}`;
}

/**
 * A generated module-level function of one entity, `<entity camel><Suffix>` (`communication` + `KindJoins` →
 * `communicationKindJoins`). The one camelCase-prefix rule for the family helpers the repository declares.
 */
export function familyHelperName(entityName: string, suffix: string): string {
	return `${camelCase(entityName)}${suffix}`;
}

// ----------------------------------------------------------------------------
// Joined-table family reads and writes (RFC-0006 §3–§4, #875)
// ----------------------------------------------------------------------------

/** The method names a family member's (or a `natural_key` entity's) repository and service carry. Fixed: no YAML spelling changes them. */
export const FAMILY_METHOD = {
	/** A child: the entity with its base row's columns hoisted to the root. */
	findWithBase: 'findWithBase',
	findManyWithBase: 'findManyWithBase',
	/** A base with child tables: reading across its kinds. */
	findAllKinds: 'findAllKinds',
	findKindById: 'findKindById',
	listKind: 'listKind',
	countKind: 'countKind',
	findOrphans: 'findOrphans',
	/** A child's list over its base's rows, flat — the base's `listKind`, hoisted; what the HTTP list reads (S5). */
	listFlat: 'listFlat',
	countFlat: 'countFlat',
	/** A child's pair write: these override the base class's, in the generated class body. */
	create: 'create',
	update: 'update',
	delete: 'delete',
	/** `natural_key: true`: the entity's own, or a child's through its base's. */
	upsertByNaturalKey: 'upsertByNaturalKey',
} as const;

// ----------------------------------------------------------------------------
// The event a write publishes (EVT-7 `emits:`)
// ----------------------------------------------------------------------------

/** The past tense a write's event type ends in: `create` publishes `<entity>_created`. */
const WRITE_EVENT_SUFFIX = { create: 'created', update: 'updated', delete: 'deleted' } as const;
export type WriteKind = keyof typeof WRITE_EVENT_SUFFIX;

/**
 * The event type a write use case publishes, or null: `<entity>_<created|updated|deleted>` when the entity's
 * `emits:` lists it. The one statement of the rule — the delete's `preRead`, the class graph's transactional use
 * cases and `prompt.js`'s `*EventType` locals all ask here.
 */
export function publishedWriteEvent(
	entityName: string,
	kind: string,
	emits: readonly string[] | null | undefined,
): string | null {
	if (!Object.hasOwn(WRITE_EVENT_SUFFIX, kind)) return null;
	const type = `${entityName}_${WRITE_EVENT_SUFFIX[kind as WriteKind]}`;
	return (emits ?? []).includes(type) ? type : null;
}
