/**
 * `roles:` public surface (CAP-2, ADR-041).
 *
 * The derivation (`derive.ts`) is also imported directly by the hygen entity
 * prompt, which cannot go through this barrel's validator import graph.
 */
export {
	ACTOR_CAPABILITY,
	COMMUNICATION_CAPABILITY,
	deriveRoleRelationships,
	junctionNamesFor,
	roleForeignKey,
	type DerivedRoleRelationship,
	type RoleCardinality,
	type RoleDefinition,
	type RoleOnDelete,
} from './derive.js';

export {
	validateRolesCommunicationPairing,
	validateRolesForGeneration,
	validateRolesProject,
	type JunctionSummary,
	type RolesProjectContext,
} from './validate-roles.js';
