/**
 * Orchestration Pattern Validator (ADR-032)
 *
 * Project-level only — orchestration patterns are not entity-attached, so
 * there is no per-entity pass. Mirrors `validatePatternProject`'s shape:
 * one pure function consuming a context object and returning structured
 * `AnalysisIssue[]` for `analyzeDomain()` to aggregate.
 *
 * Enforces ADR-032 §"Composition rules" to the extent statically checkable
 * from a `OrchestrationPatternDefinition` alone:
 *
 *   | Rule                                                       | Issue type                          |
 *   |------------------------------------------------------------|-------------------------------------|
 *   | Domain ↔ orchestration pattern share a name                | pattern_name_collision              |
 *   | Registry has zero entries                                  | pattern_entries_empty               |
 *   | Entry missing/non-string `key` or `provider`               | pattern_entry_malformed             |
 *   | Two entries in the same registry share a `key`             | pattern_entry_key_duplicate         |
 *   | Co-keyed registry's `keyType` diverges from the primary    | pattern_cokeyed_keytype_mismatch    |
 *
 * Two ADR-032 conflicts are NOT enforced here — they need consumer source
 * access that Phase 3-1 cannot do:
 *   - `keyType`/`valueType` resolution (row 2): deferred to Phase 3-2 emission.
 *   - Provider not exported by any known module (row 3): deferred to Phase 3-2
 *     + DI runtime.
 *
 * Orchestration ↔ orchestration name duplicates ARE enforced — but at LOAD
 * time inside `loadAppPatterns()`, not here, because by the time the
 * validator runs the duplicate has already been deduped by `Map.set()`
 * keying on name. The loader emits a `LoadAppPatternsResult.errors` entry.
 */

import type { AnalysisIssue } from '../analyzer/types.js';
import type { OrchestrationPatternDefinition } from './pattern-definition.js';

// Sentinel used for the `entity` field on project-level orchestration
// issues. The orchestration kind is not entity-attached, so there is no
// real entity name to point at. Existing console + markdown formatters
// treat `issue.entity` as an opaque truthy string used only in display
// (`${issue.entity}${issue.field ? '.' + issue.field : ''}`), so a
// non-entity sentinel is safe — the formatters never look it up against
// the parsed entity map.
const PROJECT_SENTINEL = '<project>';

export interface OrchestrationProjectContext {
	/** All orchestration patterns currently registered. */
	orchestrationPatterns: ReadonlyArray<OrchestrationPatternDefinition>;
	/** All domain pattern names currently registered (library + app). */
	domainPatternNames: ReadonlyArray<string>;
}

export function validateOrchestrationProject(
	ctx: OrchestrationProjectContext,
): AnalysisIssue[] {
	const issues: AnalysisIssue[] = [];

	// Rule 1: orchestration ↔ domain name collision (ADR-032 row 4).
	const domainNameSet = new Set(ctx.domainPatternNames);
	for (const orch of ctx.orchestrationPatterns) {
		if (domainNameSet.has(orch.name)) {
			issues.push({
				severity: 'error',
				type: 'pattern_name_collision',
				entity: PROJECT_SENTINEL,
				message:
					`Orchestration pattern '${orch.name}' shares a name with a domain ` +
					`pattern. Pattern names are globally unique across kinds (ADR-032 §Composition rules).`,
			});
		}
	}

	// Rules 2-4: per-pattern checks (entries shape + co-keyed keyType).
	for (const orch of ctx.orchestrationPatterns) {
		const allRegistries = [
			orch.registry,
			...(orch.coKeyedRegistries ?? []),
		];

		for (const reg of allRegistries) {
			// Rule 2: entries[] non-empty (defensive — loader already enforced
			// this for the primary registry, but co-keyed sibling registries
			// don't go through `assertOrchestrationContribution` and could be
			// authored as `entries: []`).
			if (!Array.isArray(reg.entries) || reg.entries.length === 0) {
				issues.push({
					severity: 'error',
					type: 'pattern_entries_empty',
					entity: PROJECT_SENTINEL,
					message:
						`Orchestration pattern '${orch.name}' declares a registry with ` +
						`no entries. Provide at least one { key, provider } pair.`,
				});
				continue;
			}

			// Rules 3a + 3b: per-entry well-formedness + key uniqueness.
			const seen = new Set<string>();
			for (const entry of reg.entries) {
				if (typeof entry.key !== 'string' || entry.key.length === 0) {
					issues.push({
						severity: 'error',
						type: 'pattern_entry_malformed',
						entity: PROJECT_SENTINEL,
						message:
							`Orchestration pattern '${orch.name}' has an entry with a ` +
							`missing or non-string 'key'.`,
					});
					continue;
				}
				if (
					typeof entry.provider !== 'string' ||
					entry.provider.length === 0
				) {
					issues.push({
						severity: 'error',
						type: 'pattern_entry_malformed',
						entity: PROJECT_SENTINEL,
						message:
							`Orchestration pattern '${orch.name}' entry '${entry.key}' has ` +
							`a missing or non-string 'provider'.`,
					});
					continue;
				}
				if (seen.has(entry.key)) {
					issues.push({
						severity: 'error',
						type: 'pattern_entry_key_duplicate',
						entity: PROJECT_SENTINEL,
						message:
							`Orchestration pattern '${orch.name}' has duplicate entry key ` +
							`'${entry.key}'. Keys must be unique within a registry.`,
					});
					continue;
				}
				seen.add(entry.key);
			}
		}

		// Rule 4: co-keyed registry keyType consistency (ADR-032 Decision 2).
		if (orch.coKeyedRegistries && orch.coKeyedRegistries.length > 0) {
			const primaryKeyType = orch.registry.keyType;
			for (const reg of orch.coKeyedRegistries) {
				if (reg.keyType !== primaryKeyType) {
					issues.push({
						severity: 'error',
						type: 'pattern_cokeyed_keytype_mismatch',
						entity: PROJECT_SENTINEL,
						message:
							`Orchestration pattern '${orch.name}' co-keyed registry has ` +
							`keyType '${reg.keyType}', expected '${primaryKeyType}'. ` +
							`Co-keyed registries must share the primary registry's key space (ADR-032 Decision 2).`,
					});
				}
			}
		}
	}

	return issues;
}
