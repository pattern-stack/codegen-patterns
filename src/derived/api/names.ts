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

import { camelCase } from '../../config/file-naming.js';

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

export function repositoryClassName(entityName: string): string {
	return `${pascalCase(entityName)}Repository`;
}

export function serviceClassName(entityName: string): string {
	return `${pascalCase(entityName)}Service`;
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
