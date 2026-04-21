/**
 * Pattern Composition Validator
 *
 * Enforces the ADR-031 composition rules against parsed entities:
 *
 *   | Case                                                       | Result                 |
 *   |------------------------------------------------------------|------------------------|
 *   | Column conflict between two patterns                       | error                  |
 *   | Column conflict with entity field                          | error                  |
 *   | Column conflict with a behavior field                      | error                  |
 *   | Method-name conflict between patterns                      | (TS compile error)     |
 *   | Same implied behavior across patterns                      | silent dedup           |
 *   | Pattern referenced in YAML but not in the registry         | error                  |
 *   | `config:` key for a pattern the entity is not using        | warning                |
 *   | Pattern config fails its Zod schema                        | error                  |
 *
 * Method-name conflicts are explicitly **not** checked here — they surface as
 * TypeScript compile errors at the consumer when the generated concrete
 * class extends the base. Adding a codegen check would duplicate work
 * the type system already does, so we stay silent on that row per ADR-031.
 *
 * Project-level validation (`validatePatternProject`) covers plan Risk 4:
 * entities declaring `pattern:` while `generate.architecture: clean` is
 * selected get a warning since the `clean` pipeline does not yet consume
 * patterns. Additive Phase 3+ work per ADR.
 *
 * The shape mirrors `src/behaviors/index.ts:81–124` (`validateBehaviors`):
 * a single pass that returns structured issues for `analyzeDomain()` to
 * aggregate.
 */

import type { AnalysisIssue, ParsedEntity } from '../analyzer/types.js';
import { resolveBehaviorFields } from '../behaviors/index.js';
import { getPattern } from './registry.js';

// ============================================================================
// Per-entity validation
// ============================================================================

/**
 * Validate pattern composition for a single entity. Returns an array of
 * `AnalysisIssue` values suitable for concatenation into `analyzeDomain`'s
 * aggregated issue list.
 *
 * Entities with no `pattern:` or `patterns:` declared return an empty
 * array — pattern-free entities are a valid use case (plain `BaseRepository`
 * fallback) and nothing below applies to them.
 */
export function validatePatternComposition(
	entity: ParsedEntity,
): AnalysisIssue[] {
	const issues: AnalysisIssue[] = [];

	// Normalise `pattern:` (single) and `patterns:` (multi) into one list,
	// preserving declaration order. `pattern` + `patterns` mutual exclusion
	// is a schema-level check — by the time we get here, at most one shape
	// is set.
	const patternNames: string[] = entity.patterns ?? (entity.pattern ? [entity.pattern] : []);
	if (patternNames.length === 0) return issues;

	// Column-source tracker: maps column name → human-readable origin.
	// Populated in priority order (entity fields > behavior fields >
	// pattern contributions) so conflict messages name the *existing*
	// contributor correctly.
	const columnSources = new Map<string, string>();

	for (const [name] of entity.fields) {
		columnSources.set(name, `entity field '${name}'`);
	}

	// Behavior fields participate in conflict detection. Behaviors the
	// entity has NOT already declared but that a pattern implies will be
	// added below (silent dedup); conflicts against those show up when
	// the pattern's columns are checked.
	const behaviorFields = resolveBehaviorFields(entity.behaviors);
	for (const bf of behaviorFields) {
		const existing = columnSources.get(bf.name);
		if (existing) {
			// A behavior field colliding with an entity-declared field
			// was already a codegen problem before patterns existed. We
			// surface it here too so the composition check is the single
			// authoritative pass for "column conflicts on this entity."
			issues.push({
				severity: 'error',
				type: 'pattern_column_conflict',
				entity: entity.name,
				message:
					`Behavior-contributed field '${bf.name}' conflicts with ${existing}.`,
			});
			continue;
		}
		columnSources.set(bf.name, `behavior field '${bf.name}'`);
	}

	// Track implied behaviors across all declared patterns so we can
	// assert silent dedup rather than repeat issues — this also lets us
	// return the deduped list for callers that want to thread it into
	// template-locals later without re-walking.
	const impliedBehaviors = new Set<string>(entity.behaviors);

	for (const patternName of patternNames) {
		const def = getPattern(patternName);

		// Rule: pattern referenced in YAML but not in the registry
		if (!def) {
			issues.push({
				severity: 'error',
				type: 'pattern_unknown',
				entity: entity.name,
				message:
					`Unknown pattern '${patternName}'. ` +
					`Library patterns are pre-registered; app patterns are loaded from ` +
					`globs in codegen.config.yaml 'patterns:' (default 'src/patterns/*.pattern.ts').`,
			});
			continue;
		}

		// Rule: pattern config must match the pattern's Zod schema
		if (def.configSchema) {
			const rawConfig = entity.patternConfig?.[patternName];
			const result = def.configSchema.safeParse(rawConfig ?? {});
			if (!result.success) {
				const detail = result.error.issues
					.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
					.join(', ');
				issues.push({
					severity: 'error',
					type: 'pattern_config_invalid',
					entity: entity.name,
					message:
						`Pattern '${patternName}' config failed validation: ${detail}`,
				});
			}
		}

		// Rule: column contributions conflict with anything already in the
		// column-sources table. The first column to claim a name wins; the
		// second one reports the conflict naming both contributors.
		for (const col of def.columns ?? []) {
			const existing = columnSources.get(col.name);
			if (existing) {
				issues.push({
					severity: 'error',
					type: 'pattern_column_conflict',
					entity: entity.name,
					message:
						`Pattern '${patternName}' contributes column '${col.name}' ` +
						`which conflicts with ${existing}.`,
				});
				continue;
			}
			columnSources.set(col.name, `pattern '${patternName}'`);
		}

		// Silent dedup on implied behaviors — a pattern declaring a
		// behavior the entity already has (or another pattern already
		// contributed) is a no-op, not an error.
		for (const b of def.impliedBehaviors ?? []) {
			impliedBehaviors.add(b);
		}
	}

	// Rule: `config:` key for a pattern not in the declared list → warning.
	if (entity.patternConfig) {
		const declared = new Set(patternNames);
		for (const key of Object.keys(entity.patternConfig)) {
			if (!declared.has(key)) {
				issues.push({
					severity: 'warning',
					type: 'pattern_config_unused',
					entity: entity.name,
					message:
						`Config block has key '${key}' but pattern '${key}' is not ` +
						`declared in 'pattern:' or 'patterns:'. Remove the entry or ` +
						`add the pattern.`,
				});
			}
		}
	}

	return issues;
}

// ============================================================================
// Project-level validation — plan Risk 4
// ============================================================================

export interface PatternProjectContext {
	entities: ReadonlyArray<ParsedEntity>;
	/**
	 * Selected backend architecture from `codegen.config.yaml
	 * generate.architecture`. `undefined` when the consumer is using the
	 * library purely as an analyzer (no generation config loaded).
	 */
	architecture?: string;
}

/**
 * Validate project-level invariants for patterns. Runs after
 * `validatePatternComposition` has visited every entity, so we can
 * assume per-entity errors have been surfaced.
 *
 * Today this only covers plan Risk 4: warn when patterns are declared
 * but the selected architecture is `clean`, which does not yet consume
 * them. A `clean` consumer with `pattern: Synced` is not broken — the
 * `clean` pipeline ignores the key — but they see no effect, which is
 * confusing without the warning.
 */
export function validatePatternProject(
	ctx: PatternProjectContext,
): AnalysisIssue[] {
	const issues: AnalysisIssue[] = [];

	if (ctx.architecture === 'clean') {
		const withPatterns = ctx.entities.filter(
			(e) => (e.patterns && e.patterns.length > 0) || !!e.pattern,
		);
		for (const e of withPatterns) {
			issues.push({
				severity: 'warning',
				type: 'pattern_clean_pipeline_noop',
				entity: e.name,
				message:
					`'pattern:' is declared but 'generate.architecture: clean' does not ` +
					`yet consume patterns. This declaration is a no-op. Patterns are ` +
					`consumed by 'clean-lite-ps' today; 'clean' integration is Phase 3+ ` +
					`additive work (ADR-031).`,
			});
		}
	}

	return issues;
}
