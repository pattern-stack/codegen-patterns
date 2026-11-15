/**
 * Resolve an entity's pattern composition against the registry (ADR-041) — one function, two callers.
 *
 * `compose.ts` decides the spine / capability partition with the lookup injected; this module is that decision
 * bound to the registry, with the library patterns registered. Hygen's `entity-locals.js` calls it for every
 * entity it renders, and `src/derived/api/project.ts` calls it for every entity the CLI derives, so the two
 * cannot disagree about which base class an entity extends or which methods it inherits (ADR-046).
 *
 * Throws on a composition error. Generation time is ADR-041 §4's authoritative gate —
 * `validatePatternComposition()` reports the same errors earlier, but nothing forces a consumer to run it before
 * `entity new`.
 *
 * Hygen-safe: it ships in `package.json` `files`, and imports only modules that do.
 */

import { composePatterns, declaredPatternNames, type PatternDeclaringEntity } from './compose.js';
import type { CapabilityPatternDefinition } from './pattern-definition.js';
import { getPattern } from './registry.js';
import './library/index.js';

export interface ResolvedPatternComposition {
	patternName: string;
	repositoryBaseClass: string | undefined;
	serviceBaseClass: string | undefined;
	repositoryBaseImport: string | undefined;
	serviceBaseImport: string | undefined;
	/** Comma-separated method lists, as the spine declares them. */
	repositoryInheritedMethods: string[];
	serviceInheritedMethods: string[];
	capabilities: CapabilityPatternDefinition[];
}

export function resolvePatternComposition(entity: PatternDeclaringEntity & { name: string }): ResolvedPatternComposition {
	const names = declaredPatternNames(entity);
	const composed = composePatterns(names, getPattern, { entity: entity.name });

	if (composed.errors.length > 0) {
		throw new Error(
			`[codegen] pattern composition failed for '${entity.name}':\n  ` +
				composed.errors.map((e) => e.message).join('\n  '),
		);
	}

	const def = composed.spine;
	if (!def) {
		throw new Error(
			`Pattern '${composed.spineName}' is not registered, and the library 'Base' ` +
				`pattern is also missing. Did the patterns barrel fail to load?`,
		);
	}

	return {
		patternName: def.name,
		repositoryBaseClass: def.repositoryClass,
		serviceBaseClass: def.serviceClass,
		repositoryBaseImport: def.repositoryImport,
		serviceBaseImport: def.serviceImport,
		repositoryInheritedMethods: def.repositoryInheritedMethods ?? [],
		serviceInheritedMethods: def.serviceInheritedMethods ?? [],
		capabilities: composed.capabilities,
	};
}
