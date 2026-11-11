/**
 * The behaviors an entity's declared pattern(s) imply (ADR-031).
 *
 * A pattern (e.g. `Integrated`) may declare `impliedBehaviors` — behaviors the
 * entity gets without re-declaring them in its `behaviors:` array. Walks every
 * declared pattern (both the `pattern: X` and `patterns: [...]` shapes), unions
 * their `impliedBehaviors`, and returns a deduped list. Unknown patterns are
 * skipped silently — composition validation surfaces those separately
 * (`validate-composition.ts`).
 *
 * The one owner: the backend locals builder and `resolveTenancy`'s column
 * collision check both read it.
 */

import { getPattern } from './registry.js';
import './library/index.js';

/** The `entity:` block fields this reads. */
export interface PatternDeclaration {
	pattern?: string | null;
	patterns?: string[] | null;
}

export function resolveImpliedBehaviors(entity: PatternDeclaration): string[] {
	const names: string[] = [];
	if (typeof entity.pattern === 'string' && entity.pattern) names.push(entity.pattern);
	if (Array.isArray(entity.patterns)) names.push(...entity.patterns);

	const implied = new Set<string>();
	for (const name of names) {
		for (const b of getPattern(name)?.impliedBehaviors ?? []) implied.add(b);
	}
	return Array.from(implied);
}
