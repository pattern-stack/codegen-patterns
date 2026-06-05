/**
 * Shared fixtures for the frontend emitter tests (ADR-038, FE-2).
 *
 * String-level tests: builders are pure, so the suites assert on returned
 * strings with no fs — the technique inherited from the deleted
 * frontend-sync-mode.test.ts.
 */

import type { EntityRegistryEntry } from '../../../parser/entity-registry';
import type {
	ParsedEntity,
	ParsedField,
	ParsedRelationship,
} from '../../../analyzer/types';
import type { FrontendEmitConfig, FrontendEmitContext } from '../../../emitters/frontend/types';

const camelCase = (s: string): string =>
	s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const pascalCase = (s: string): string => {
	const camel = camelCase(s);
	return camel.charAt(0).toUpperCase() + camel.slice(1);
};

/** Build a registry entry from name/plural; class & camel names derived. */
export function entry(
	name: string,
	plural: string,
	sync: 'api' | 'electric' | null = null,
): EntityRegistryEntry {
	return {
		name,
		plural,
		table: plural,
		className: pascalCase(name),
		classNamePlural: pascalCase(plural),
		camelName: camelCase(name),
		pluralCamelName: camelCase(plural),
		sync,
	};
}

/** A complete config with sensible defaults; override per test. */
export function config(over: Partial<FrontendEmitConfig> = {}): FrontendEmitConfig {
	return {
		globalSyncMode: 'electric',
		authFunction: null,
		authImport: '@/lib/collections/auth',
		shapeUrl: '/v1/shape',
		useTableParam: false,
		columnMapper: null,
		columnMapperNeedsCall: true,
		apiUrl: '/api',
		apiBaseUrlImport: null,
		parsers: {},
		architecture: 'clean',
		dbEntitiesImport: '@repo/db/entities',
		...over,
	};
}

/** Build a `ParsedField` from a name + overrides; sensible defaults. */
export function field(
	name: string,
	over: Partial<ParsedField> = {},
): ParsedField {
	return {
		name,
		type: 'string',
		required: false,
		nullable: false,
		unique: false,
		index: false,
		constraints: {},
		ui: {},
		...over,
	};
}

/** Build a `ParsedRelationship` (belongs_to by default). */
export function relationship(
	name: string,
	over: Partial<ParsedRelationship> & { target: string; foreignKey: string },
): ParsedRelationship {
	return {
		name,
		type: 'belongs_to',
		resolved: true,
		...over,
	};
}

/** Build a `ParsedEntity` from a registry entry + fields/relationships. */
export function parsedEntity(
	e: EntityRegistryEntry,
	over: Partial<ParsedEntity> = {},
): ParsedEntity {
	return {
		name: e.name,
		plural: e.plural,
		table: e.table,
		expose: ['repository', 'rest', 'trpc'],
		folderStructure: 'nested',
		fields: new Map(),
		relationships: new Map(),
		behaviors: [],
		sourcePath: `entities/${e.name}.yaml`,
		...over,
	};
}

/** Build a `parsed` map keyed by entity name from a list of parsed entities. */
export function parsedMap(...entities: ParsedEntity[]): Map<string, ParsedEntity> {
	return new Map(entities.map((p) => [p.name, p]));
}

/**
 * Build a context from an entity list + config overrides. `parsed` defaults to
 * an empty registry-derived map (one entry per entity, no fields/relationships)
 * unless an explicit map is supplied.
 */
export function ctx(
	entities: EntityRegistryEntry[],
	configOver: Partial<FrontendEmitConfig> = {},
	parsed?: Map<string, ParsedEntity>,
): FrontendEmitContext {
	return {
		entities,
		parsed: parsed ?? new Map(entities.map((e) => [e.name, parsedEntity(e)])),
		config: config(configOver),
	};
}
