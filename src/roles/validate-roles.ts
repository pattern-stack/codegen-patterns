/**
 * `roles:` — project-level validation (CAP-2, ADR-041).
 *
 * The per-entity rules live with the per-entity validator
 * (`src/patterns/validate-composition.ts`: `roles:` requires the
 * `Communication` capability and vice versa). Everything here needs something
 * the entity itself cannot see:
 *
 *   - does the `target` entity exist, and does it declare `Actor`?
 *   - does a `many` role's `via:` name a junction between these two entities?
 *
 * Runs after `resolveReferences()` in `analyzeDomain`, next to
 * `validateOrchestrationProject`.
 *
 * See `docs/specs/CAP-2.md` §5.
 */

import type { AnalysisIssue, ParsedEntity } from '../analyzer/types.js';
import { declaredPatternNames } from '../patterns/compose.js';
import { isCapabilityPattern } from '../patterns/pattern-definition.js';
import { getPattern } from '../patterns/registry.js';
import {
	ACTOR_CAPABILITY,
	COMMUNICATION_CAPABILITY,
	junctionNamesFor,
} from './derive.js';

/** The junction facts this validator needs — name plus its declared pairing. */
export interface JunctionSummary {
	name: string;
	between: readonly [string, string];
}

export interface RolesProjectContext {
	entities: ReadonlyArray<ParsedEntity>;
	/**
	 * Junctions discovered for this project, when the caller has them. The CLI
	 * passes them (`junctions/`); a bare `analyzeDomain(entitiesDir)` does not.
	 *
	 * Absent, a `many` role's `via:` is still checked against the junction
	 * NAMING rule, which is exact — a junction is named `<a>_<b>` from its
	 * `between:` and has no YAML override. Only "a junction file with that name
	 * exists" needs the list.
	 */
	junctions?: ReadonlyArray<JunctionSummary>;
}

/** Does this entity declare a `kind: 'capability'` pattern of this name? */
function declaresCapability(entity: ParsedEntity, capability: string): boolean {
	const names = declaredPatternNames(entity);
	if (!names.includes(capability)) return false;
	const def = getPattern(capability);
	return def !== undefined && isCapabilityPattern(def);
}

/**
 * Per-entity rule: `roles:` and the `Communication` capability imply each
 * other. A `roles:` block with no `Communication` declares participants nothing
 * will ever read; `Communication` with no `roles:` layers a mixin whose whole
 * vocabulary is driven by roles that do not exist. Both are author mistakes
 * with silent consequences, so both are errors.
 *
 * Called by `validatePatternComposition` (analyze / validate) and by the
 * `entity new` pre-flight (`validateRolesForGeneration`), so the rule has one
 * implementation.
 */
export function validateRolesCommunicationPairing(
	entity: ParsedEntity,
	patternNames: readonly string[],
): AnalysisIssue[] {
	const issues: AnalysisIssue[] = [];
	const declaresCommunication = patternNames.includes(COMMUNICATION_CAPABILITY);
	const hasRoles = (entity.roles?.size ?? 0) > 0;
	if (hasRoles && !declaresCommunication) {
		issues.push({
			severity: 'error',
			type: 'role_without_communication',
			entity: entity.name,
			message:
				`Entity declares 'roles:' but not the '${COMMUNICATION_CAPABILITY}' ` +
				`capability. Add '${COMMUNICATION_CAPABILITY}' to 'patterns:' — it is ` +
				`what reads the roles.`,
		});
	}
	if (declaresCommunication && !hasRoles) {
		issues.push({
			severity: 'error',
			type: 'communication_without_roles',
			entity: entity.name,
			message:
				`Entity declares the '${COMMUNICATION_CAPABILITY}' capability but no ` +
				`'roles:' block. Declare the roles its participants occupy, or drop ` +
				`the capability.`,
		});
	}
	return issues;
}

export function validateRolesProject(
	ctx: RolesProjectContext,
): AnalysisIssue[] {
	const issues: AnalysisIssue[] = [];

	const byName = new Map<string, ParsedEntity>();
	for (const entity of ctx.entities) byName.set(entity.name, entity);

	const junctionNames = ctx.junctions
		? new Map(ctx.junctions.map((j) => [j.name, j]))
		: null;

	for (const entity of ctx.entities) {
		if (!entity.roles || entity.roles.size === 0) continue;

		for (const role of entity.roles.values()) {
			const target = byName.get(role.target);

			if (!target) {
				issues.push({
					severity: 'error',
					type: 'role_target_unknown',
					entity: entity.name,
					message:
						`Role '${role.name}' targets '${role.target}', which is not a ` +
						`known entity. Known entities: ${[...byName.keys()].sort().join(', ')}.`,
				});
				continue;
			}

			if (!declaresCapability(target, ACTOR_CAPABILITY)) {
				issues.push({
					severity: 'error',
					type: 'role_target_not_actor',
					entity: entity.name,
					message:
						`Role '${role.name}' targets '${role.target}', which does not ` +
						`declare the '${ACTOR_CAPABILITY}' capability. Add '${ACTOR_CAPABILITY}' ` +
						`to ${role.target}'s patterns: — it is a kind: 'capability' pattern, ` +
						`so it layers over whatever base ${role.target} already has.`,
				});
			}

			if (role.cardinality !== 'many') continue;

			const via = role.via;
			const candidates = junctionNamesFor(entity.name, role.target);
			if (!candidates.includes(via)) {
				issues.push({
					severity: 'error',
					type: 'role_via_mismatch',
					entity: entity.name,
					message:
						`Role '${role.name}' declares 'via: ${via}', which cannot be a ` +
						`junction between '${entity.name}' and '${role.target}'. A junction ` +
						`is named after its pairing, so this must be one of: ` +
						`${candidates.join(', ')}.`,
				});
				continue;
			}

			if (!junctionNames) continue;

			const junction = junctionNames.get(via);
			if (!junction) {
				issues.push({
					severity: 'error',
					type: 'role_via_unknown',
					entity: entity.name,
					message:
						`Role '${role.name}' declares 'via: ${via}', but no junction of ` +
						`that name was found. Declare it: a junction YAML with ` +
						`'between: [${entity.name}, ${role.target}]'.`,
				});
				continue;
			}

			const pair = new Set(junction.between);
			if (!pair.has(entity.name) || !pair.has(role.target)) {
				issues.push({
					severity: 'error',
					type: 'role_via_mismatch',
					entity: entity.name,
					message:
						`Role '${role.name}' declares 'via: ${via}', but that junction is ` +
						`between '${junction.between.join("' and '")}' — not ` +
						`'${entity.name}' and '${role.target}'.`,
				});
			}
		}
	}

	return issues;
}

/**
 * Every roles error that must stop `entity new` for the entities being
 * generated.
 *
 * Roles are cross-entity — a role's target lives in another YAML file, and a
 * `many` role's junction in a third — so neither the schema nor the
 * one-entity-at-a-time hygen prompt can see them. The CLI can: it has already
 * loaded every entity for the EVT-7 `emits:` pre-flight. Generation is the gate
 * that matters (a consumer is not required to run `entity validate` first), so
 * this makes a bad role a generation-time error, the same posture ADR-041 §4
 * takes for composition.
 */
export function validateRolesForGeneration(ctx: {
	/** Entities about to be generated. */
	targets: ReadonlyArray<ParsedEntity>;
	/** Every entity in the project — role targets are looked up here. */
	entities: ReadonlyArray<ParsedEntity>;
	junctions: ReadonlyArray<JunctionSummary>;
}): AnalysisIssue[] {
	const targetNames = new Set(ctx.targets.map((e) => e.name));
	const pairing = ctx.targets.flatMap((e) =>
		validateRolesCommunicationPairing(
			e,
			declaredPatternNames(e),
		),
	);
	const project = validateRolesProject({
		entities: ctx.entities,
		junctions: ctx.junctions,
	}).filter((i) => i.entity !== undefined && targetNames.has(i.entity));
	return [...pairing, ...project].filter((i) => i.severity === 'error');
}
