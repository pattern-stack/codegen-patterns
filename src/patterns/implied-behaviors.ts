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
 * The one owner: the backend locals builder, `resolveTenancy`'s column
 * collision check and the relations manifest's scope derivation all read it.
 * The manifest reads it through {@link requireImpliedBehaviors}, which refuses
 * an unregistered pattern instead of skipping it: a scope computed from a
 * registry the app patterns never reached would silently drop their implied
 * `soft_delete` / `user_tracking` from every hop and from `SCOPES` (READ-1).
 */

import { getPattern } from './registry.js';
import './library/index.js';

/** The `entity:` block fields this reads. */
export interface PatternDeclaration {
	pattern?: string | null;
	patterns?: string[] | null;
}

function declaredPatternNames(entity: PatternDeclaration): string[] {
	const names: string[] = [];
	if (typeof entity.pattern === 'string' && entity.pattern) names.push(entity.pattern);
	if (Array.isArray(entity.patterns)) names.push(...entity.patterns);
	return names;
}

function impliedBy(names: readonly string[]): string[] {
	const implied = new Set<string>();
	for (const name of names) {
		for (const b of getPattern(name)?.impliedBehaviors ?? []) implied.add(b);
	}
	return Array.from(implied);
}

export function resolveImpliedBehaviors(entity: PatternDeclaration): string[] {
	return impliedBy(declaredPatternNames(entity));
}

/**
 * The behaviors a CHILD of a joined-table family reads through its base because a pattern it declares says so
 * (`readsThroughBase`, RFC-0006 §4.2 / S7): the base owns their columns, so the child's table gets none and the
 * behavior the pattern implies on the child is not an R5 error. The ONE reader of the property.
 */
export function behaviorsReadThroughBase(entity: PatternDeclaration): string[] {
	const out = new Set<string>();
	for (const name of declaredPatternNames(entity)) {
		for (const b of getPattern(name)?.readsThroughBase ?? []) out.add(b);
	}
	return Array.from(out);
}

/**
 * The behaviors an entity HAS: those it declares (explicit first) plus those its pattern(s) imply, deduped. The ONE
 * derivation of "resolved behaviours": the backend locals builder and the frontend emitter both call it, so a new
 * behaviour source is added here once. (The relations manifest states the same rule with the throwing
 * {@link requireImpliedBehaviors}, deliberately.)
 */
export function resolvedBehaviorNames(
	declared: readonly (string | { name: string })[],
	entity: PatternDeclaration,
): string[] {
	const explicit = declared.map((b) => (typeof b === 'string' ? b : b.name));
	return [...explicit, ...resolveImpliedBehaviors(entity).filter((b) => !explicit.includes(b))];
}

/**
 * {@link resolveImpliedBehaviors}, but a declared pattern that is not in this
 * process's registry THROWS, naming the entity and the pattern. For a derivation
 * whose output is a security posture (the manifest's per-hop and root scope): an
 * unregistered pattern there means the caller never loaded the app patterns, and
 * skipping it would emit a narrower scope than the repository applies.
 */
export function requireImpliedBehaviors(entity: PatternDeclaration, entityName: string): string[] {
	const names = declaredPatternNames(entity);
	for (const name of names) {
		if (!getPattern(name)) {
			throw new Error(
				`entity '${entityName}' declares pattern '${name}', which is not registered — ` +
					'its implied behaviors would be missing from the scope. Load the app patterns ' +
					'(`codegen.config.yaml patterns:`) before deriving it.',
			);
		}
	}
	return impliedBy(names);
}
