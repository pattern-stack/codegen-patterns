/**
 * Pattern composition — spine selection + capability layering (ADR-041).
 *
 * TypeScript allows exactly one base class. A composed entity therefore emits
 * **one inherited spine** (a domain pattern) plus **N layered capabilities**
 * (`kind: 'capability'`), and this module is where that partition is decided —
 * once, for every caller:
 *
 *   - `validatePatternComposition()` reports the errors as `AnalysisIssue`s at
 *     `analyze` / `entity validate` time;
 *   - the clean-lite-ps locals builder throws them at generation time, which is
 *     the authoritative gate (ADR-041 §4).
 *
 * Nothing here touches the registry — the lookup is injected — so the hygen
 * subprocess and the analyzer share one implementation with no import cycle.
 *
 * See `docs/adrs/ADR-041-capability-composition-emission.md` and
 * `docs/specs/CAP-1.md` §2.
 */

import {
	isCapabilityPattern,
	isDomainPattern,
	type CapabilityPatternDefinition,
	type EntityPatternDefinition,
	type PatternDefinition,
} from './pattern-definition.js';

/** Name of the library pattern used as the spine when nothing else is inheritable. */
export const DEFAULT_SPINE = 'Base';

export type CompositionErrorCode =
	| 'pattern_multiple_spines'
	| 'pattern_method_collision';

export interface CompositionError {
	code: CompositionErrorCode;
	message: string;
}

export interface ComposedPatterns {
	/** The pattern whose repository/service class the entity extends. */
	spineName: string;
	/** Resolved spine record — `undefined` only when even `Base` is unregistered. */
	spine: PatternDefinition | undefined;
	/**
	 * Capabilities in declaration order. Mixin nesting follows this order with
	 * the **rightmost outermost** (ADR-041 §6), i.e. `[A, B]` emits `B(A(Spine))`.
	 */
	capabilities: CapabilityPatternDefinition[];
	/** Declared names the lookup could not resolve. Reported by the caller. */
	unknown: string[];
	errors: CompositionError[];
}

/** Minimal shape of the parsed entity block this module reads. */
export interface PatternDeclaringEntity {
	name?: string;
	pattern?: string;
	patterns?: string[];
}

/**
 * Normalise `pattern:` (single) and `patterns:` (multi) into one list,
 * preserving declaration order. The two are mutually exclusive at the schema
 * level, so at most one shape is set by the time anything calls this.
 */
export function declaredPatternNames(
	entity: PatternDeclaringEntity,
): string[] {
	if (Array.isArray(entity.patterns) && entity.patterns.length > 0) {
		return [...entity.patterns];
	}
	return entity.pattern ? [entity.pattern] : [];
}

/**
 * Partition an entity's declared patterns into one spine + N capabilities.
 *
 * **Spine selection is not positional** (ADR-041 §2). Reordering `patterns:`
 * must never change which class is inherited, so the spine is *the* declared
 * domain pattern that contributes an inheritable base — wherever it sits in the
 * list. A candidate another candidate `extends` is dropped as redundant rather
 * than treated as a competitor, so `patterns: [Base, Integrated]` resolves to
 * `Integrated` (ADR-031's single-depth chain; ADR-041 open follow-up #3).
 *
 * Two surviving candidates is a hard error. Single inheritance means one of
 * them could only be dropped, and dropping one silently is the defect ADR-041
 * exists to fix.
 */
export function composePatterns(
	names: readonly string[],
	lookup: (name: string) => EntityPatternDefinition | undefined,
	opts: { entity?: string } = {},
): ComposedPatterns {
	const errors: CompositionError[] = [];
	const unknown: string[] = [];
	const capabilities: CapabilityPatternDefinition[] = [];
	const domains: PatternDefinition[] = [];

	for (const name of names) {
		const def = lookup(name);
		if (!def) {
			unknown.push(name);
			continue;
		}
		if (isCapabilityPattern(def)) {
			capabilities.push(def);
		} else if (isDomainPattern(def)) {
			domains.push(def);
		}
	}

	const candidates = domains.filter(
		(d) =>
			(typeof d.repositoryClass === 'string' && d.repositoryClass.length > 0) ||
			(typeof d.serviceClass === 'string' && d.serviceClass.length > 0),
	);

	// Drop candidates that another candidate already extends — a declared
	// ancestor is redundant, not a second spine.
	const extended = new Set<string>();
	for (const c of candidates) {
		for (const parent of c.extends ?? []) extended.add(parent);
	}
	const spines = candidates.filter((c) => !extended.has(c.name));

	const where = opts.entity ? `Entity '${opts.entity}'` : 'This entity';

	if (spines.length > 1) {
		errors.push({
			code: 'pattern_multiple_spines',
			message:
				`${where} declares ${spines.length} inheritable spine bases ` +
				`(${spines.map((s) => s.name).join(', ')}). Only one inheritable spine ` +
				`base is allowed; express the other capability as kind: 'capability'.`,
		});
	}

	const spineDef = spines.length === 1 ? spines[0] : undefined;
	const spineName = spineDef ? spineDef.name : DEFAULT_SPINE;
	const resolvedSpine = spineDef ?? asDomain(lookup(DEFAULT_SPINE));

	return { spineName, spine: resolvedSpine, capabilities, unknown, errors };
}

function asDomain(
	def: EntityPatternDefinition | undefined,
): PatternDefinition | undefined {
	if (!def || isCapabilityPattern(def)) return undefined;
	return def;
}

/** One named set of method names participating in the collision check. */
export interface MethodVocabulary {
	/** Human-readable origin, e.g. `capability 'Actor'` or `queries:`. */
	source: string;
	methods: readonly string[];
	/**
	 * Whether this vocabulary comes from a capability. Only collisions that
	 * involve at least one capability are reported — see below.
	 */
	capability: boolean;
}

/**
 * Pre-detect method-name collisions across the codegen-known vocabularies
 * (ADR-041 §4): a capability's `forwarderMethods`, `queries:` methods, and
 * relationship forwarders. A generation-time error here is a better answer than
 * the `TS2393` a consumer would otherwise meet in generated code.
 *
 * Only collisions **involving a capability** are reported. The `queries:` ×
 * FK-traversal overlap is pre-existing, intentional and already resolved by a
 * documented precedence rule with its own emission logic
 * (`clean-lite-ps/repository.ejs.t`) — it is a resolved overlap, not an
 * undetected clash, and reporting it would break working entities.
 *
 * Opaque spine-base methods stay invisible to codegen (ADR-041 Context #1), so
 * a clash against one still surfaces as a consumer compile error. That
 * remainder is irreducible and ADR-041 §4 leaves it to `tsc` on purpose.
 */
export function detectMethodCollisions(
	vocabs: readonly MethodVocabulary[],
): CompositionError[] {
	const seen = new Map<string, MethodVocabulary[]>();
	for (const vocab of vocabs) {
		for (const method of vocab.methods) {
			const owners = seen.get(method);
			if (owners) {
				if (!owners.includes(vocab)) owners.push(vocab);
			} else {
				seen.set(method, [vocab]);
			}
		}
	}

	const errors: CompositionError[] = [];
	for (const [method, owners] of seen) {
		if (owners.length < 2) continue;
		if (!owners.some((o) => o.capability)) continue;
		errors.push({
			code: 'pattern_method_collision',
			message:
				`Method '${method}' is contributed by ${owners
					.map((o) => o.source)
					.join(' and ')}. Rename one of them — the composed class can only ` +
				`declare it once.`,
		});
	}
	return errors.sort((a, b) => a.message.localeCompare(b.message));
}
