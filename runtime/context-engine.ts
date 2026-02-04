import { z } from 'zod';

/**
 * Context Engine Types
 *
 * Shared types and validation for the polymorphic relationships and facts system.
 * These types are generated from the relationship_types.yaml DSL definition.
 */

// ============================================================================
// Entity Types
// ============================================================================

/**
 * All valid entity types that can participate in relationships
 */
export const ENTITY_TYPES = [
  'person',
  'organization',
  'opportunity',
  'engagement',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export const entityTypeSchema = z.enum(ENTITY_TYPES);

// ============================================================================
// Relationship Types
// ============================================================================

/**
 * All valid relationship types
 */
export const RELATIONSHIP_TYPES = [
  'works_at',
  'reports_to',
  'works_with',
  'stakeholder_on',
  'belongs_to',
  'parent_of',
  'participated_in',
  'related_to_opportunity',
  'related_to_organization',
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export const relationshipTypeSchema = z.enum(RELATIONSHIP_TYPES);

// ============================================================================
// Relationship Direction
// ============================================================================

export const RELATIONSHIP_DIRECTIONS = ['directed', 'bidirectional'] as const;

export type RelationshipDirection = (typeof RELATIONSHIP_DIRECTIONS)[number];

// ============================================================================
// Stakeholder Roles (for stakeholder_on relationship)
// ============================================================================

export const STAKEHOLDER_ROLES = [
  'decision_maker',
  'influencer',
  'champion',
  'blocker',
  'user',
  'economic_buyer',
  'technical_buyer',
] as const;

export type StakeholderRole = (typeof STAKEHOLDER_ROLES)[number];

export const stakeholderRoleSchema = z.enum(STAKEHOLDER_ROLES);

// ============================================================================
// Relationship Constraints
// ============================================================================

/**
 * Defines valid from/to entity type combinations for each relationship type.
 * Used at runtime to validate relationship creation.
 */
export const RELATIONSHIP_CONSTRAINTS: Record<
  RelationshipType,
  {
    from: readonly EntityType[];
    to: readonly EntityType[];
    direction: RelationshipDirection;
    temporal: boolean;
  }
> = {
  works_at: {
    from: ['person'],
    to: ['organization'],
    direction: 'directed',
    temporal: true,
  },
  reports_to: {
    from: ['person'],
    to: ['person'],
    direction: 'directed',
    temporal: true,
  },
  works_with: {
    from: ['person'],
    to: ['person'],
    direction: 'bidirectional',
    temporal: true,
  },
  stakeholder_on: {
    from: ['person', 'organization'],
    to: ['opportunity'],
    direction: 'directed',
    temporal: true,
  },
  belongs_to: {
    from: ['opportunity'],
    to: ['organization'],
    direction: 'directed',
    temporal: false,
  },
  parent_of: {
    from: ['organization'],
    to: ['organization'],
    direction: 'directed',
    temporal: false,
  },
  participated_in: {
    from: ['person'],
    to: ['engagement'],
    direction: 'directed',
    temporal: false,
  },
  related_to_opportunity: {
    from: ['engagement'],
    to: ['opportunity'],
    direction: 'directed',
    temporal: false,
  },
  related_to_organization: {
    from: ['engagement'],
    to: ['organization'],
    direction: 'directed',
    temporal: false,
  },
} as const;

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Check if a relationship type is valid for the given from/to entity types
 */
export function isValidRelationship(
  relationshipType: RelationshipType,
  fromType: EntityType,
  toType: EntityType,
): boolean {
  const constraint = RELATIONSHIP_CONSTRAINTS[relationshipType];
  if (!constraint) return false;

  return constraint.from.includes(fromType) && constraint.to.includes(toType);
}

/**
 * Get the constraint definition for a relationship type
 */
export function getRelationshipConstraint(
  relationshipType: RelationshipType,
): (typeof RELATIONSHIP_CONSTRAINTS)[RelationshipType] {
  return RELATIONSHIP_CONSTRAINTS[relationshipType];
}

/**
 * Check if a relationship type supports temporal tracking
 */
export function isTemporalRelationship(
  relationshipType: RelationshipType,
): boolean {
  return RELATIONSHIP_CONSTRAINTS[relationshipType]?.temporal ?? false;
}

/**
 * Get all valid relationship types where the given entity type can be the "from" side
 */
export function getRelationshipTypesFrom(
  entityType: EntityType,
): RelationshipType[] {
  return RELATIONSHIP_TYPES.filter((rt) =>
    RELATIONSHIP_CONSTRAINTS[rt].from.includes(entityType),
  );
}

/**
 * Get all valid relationship types where the given entity type can be the "to" side
 */
export function getRelationshipTypesTo(
  entityType: EntityType,
): RelationshipType[] {
  return RELATIONSHIP_TYPES.filter((rt) =>
    RELATIONSHIP_CONSTRAINTS[rt].to.includes(entityType),
  );
}

// ============================================================================
// Relationship Zod Schemas
// ============================================================================

/**
 * Schema for creating a new relationship
 */
export const createRelationshipSchema = z.object({
  tenantId: z.string().uuid(),
  fromEntityType: entityTypeSchema,
  fromEntityId: z.string().uuid(),
  toEntityType: entityTypeSchema,
  toEntityId: z.string().uuid(),
  relationshipType: relationshipTypeSchema,
  metadata: z.record(z.unknown()).optional(),
  validFrom: z.coerce.date().optional(),
  validTo: z.coerce.date().optional(),
});

export type CreateRelationshipInput = z.infer<typeof createRelationshipSchema>;

/**
 * Schema for updating a relationship
 */
export const updateRelationshipSchema = z.object({
  metadata: z.record(z.unknown()).optional(),
  validTo: z.coerce.date().optional(),
  isActive: z.boolean().optional(),
});

export type UpdateRelationshipInput = z.infer<typeof updateRelationshipSchema>;

/**
 * Schema for a relationship record (from database)
 */
export const relationshipSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  fromEntityType: entityTypeSchema,
  fromEntityId: z.string().uuid(),
  toEntityType: entityTypeSchema,
  toEntityId: z.string().uuid(),
  relationshipType: relationshipTypeSchema,
  metadata: z.record(z.unknown()).nullable(),
  validFrom: z.coerce.date().nullable(),
  validTo: z.coerce.date().nullable(),
  isActive: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: z.coerce.date().nullable(),
});

export type Relationship = z.infer<typeof relationshipSchema>;

// ============================================================================
// Fact Zod Schemas
// ============================================================================

/**
 * Schema for creating a new fact
 */
export const createFactSchema = z.object({
  tenantId: z.string().uuid(),
  entityType: entityTypeSchema,
  entityId: z.string().uuid(),
  factText: z.string().min(1),
  tags: z.array(z.string()).optional(),
  sourceType: z.string().max(50).optional(),
  sourceReference: z.record(z.unknown()).optional(),
  confidenceScore: z.number().min(0).max(1).optional(),
  validFrom: z.coerce.date().optional(),
  validTo: z.coerce.date().optional(),
});

export type CreateFactInput = z.infer<typeof createFactSchema>;

/**
 * Schema for updating a fact
 */
export const updateFactSchema = z.object({
  factText: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  confidenceScore: z.number().min(0).max(1).optional(),
  validTo: z.coerce.date().optional(),
  isActive: z.boolean().optional(),
});

export type UpdateFactInput = z.infer<typeof updateFactSchema>;

/**
 * Schema for a fact record (from database)
 */
export const factSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  entityType: entityTypeSchema,
  entityId: z.string().uuid(),
  factText: z.string(),
  tags: z.array(z.string()).nullable(),
  sourceType: z.string().nullable(),
  sourceReference: z.record(z.unknown()).nullable(),
  confidenceScore: z.string().nullable(), // decimal comes back as string
  isActive: z.boolean(),
  validFrom: z.coerce.date().nullable(),
  validTo: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: z.coerce.date().nullable(),
});

export type Fact = z.infer<typeof factSchema>;

// ============================================================================
// Entity Reference (for polymorphic lookups)
// ============================================================================

/**
 * A reference to any entity in the system
 */
export interface EntityRef {
  entityType: EntityType;
  entityId: string;
}

export const entityRefSchema = z.object({
  entityType: entityTypeSchema,
  entityId: z.string().uuid(),
});

/**
 * Create an entity reference
 */
export function createEntityRef(
  entityType: EntityType,
  entityId: string,
): EntityRef {
  return { entityType, entityId };
}
