/**
 * Shared fixtures for the frontend emitter tests (ADR-038, FE-2).
 *
 * String-level tests: builders are pure, so the suites assert on returned
 * strings with no fs — the technique inherited from the deleted
 * frontend-sync-mode.test.ts.
 */

import type { EntityRegistryEntry } from '../../../parser/entity-registry';
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

/** Build a context from an entity list + config overrides. */
export function ctx(
	entities: EntityRegistryEntry[],
	configOver: Partial<FrontendEmitConfig> = {},
): FrontendEmitContext {
	return { entities, config: config(configOver) };
}
