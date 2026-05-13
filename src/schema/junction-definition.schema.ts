import { z } from 'zod';
import { BASE_JUNCTION_FIELD_NAMES } from '../patterns/library/base-junction-fields.js';

/**
 * Junction Definition Schema
 *
 * Top-level YAML contract for explicit many-to-many junctions between two
 * entities. Sibling to `relationship-definition.schema.ts`: same authoring
 * model (typed, temporal, sourced association), different topology.
 *
 * A junction file's top-level discriminator is `pattern: Junction` (not
 * `entity:` or `relationship:`). The pairing endpoints live in
 * `between: [<entity>, <entity>]` — both intra-domain (e.g.
 * `[opportunity, contact]`) and cross-domain (e.g. `[opportunity, activity]`)
 * are accepted; existence of the named entities is verified by the
 * analyzer in a later leaf, not by this schema.
 *
 * Per-pairing role enums + pairing-specific fields are declared inside the
 * consumer YAML's `fields:` block. They are NEVER shared across pairings
 * (CLAUDE.md "Explicit junctions"); the schema enforces locality by
 * rejecting indirection syntax via `.strict()`.
 *
 * See: docs/adrs/ADR-031-app-defined-patterns.md
 * See: .ai-docs/stacks/codegen-app-patterns/specs/58.md
 * See: test/fixtures/junctions/ for examples
 */

// ============================================================================
// Entity Name
// ============================================================================

const EntityNameSchema = z
	.string()
	.regex(/^[a-z][a-z0-9_]*$/, 'Entity reference must be snake_case');

// ============================================================================
// Junction Definition
// ============================================================================

/**
 * Top-level junction YAML shape.
 *
 *   pattern: Junction
 *   between: [opportunity, contact]
 *   temporal: true        # optional, default true
 *   sourced: true         # optional, default true
 *   fields:
 *     role:
 *       type: enum
 *       values: [champion, decision_maker, influencer]
 *   queries:
 *     - by: [opportunity_id]
 *
 * Fields use the same shape as entity fields — validated downstream by the
 * template / codegen layer using the existing `FieldDefinitionSchema`.
 * This schema accepts the shape loosely (`z.any()`) and applies only the
 * reserved-column collision check; matches the relationship-schema
 * precedent (`relationship-definition.schema.ts` line ~250).
 */
export const JunctionDefinitionSchema = z
	.object({
		/** Discriminator literal — `pattern: Junction`. */
		pattern: z.literal('Junction'),

		/**
		 * Exactly two endpoint entity names. Both intra- and cross-domain
		 * pairings are accepted; entity existence is validated by the
		 * analyzer in a later leaf.
		 */
		between: z.tuple([EntityNameSchema, EntityNameSchema]),

		/**
		 * Emit BaseJunctionFields temporal columns (`started_at`, `ended_at`,
		 * `matched_at`). Default true. Matches Relationship's `temporal` toggle.
		 */
		temporal: z.boolean().optional().default(true),

		/**
		 * Emit BaseJunctionFields sourcing columns (`sourced_from`,
		 * `confidence`). Default true. Matches Relationship's `sourced` toggle.
		 */
		sourced: z.boolean().optional().default(true),

		/**
		 * Junction-specific fields beyond `BaseJunctionFields`. Includes the
		 * per-pairing role enum (declared inline; never shared across
		 * pairings). Shape is validated downstream by the codegen layer
		 * using the existing entity FieldDefinitionSchema.
		 */
		fields: z.record(z.string(), z.any()).optional(),

		/**
		 * Declarative queries — same syntax as entity queries. Shape is
		 * validated downstream by the codegen layer.
		 */
		queries: z.array(z.any()).optional(),

		/**
		 * Per-side opt-out for parent-service fan-out (CGP-60). When a side
		 * is `false`, the `_inject-parent-service-*` templates emit nothing
		 * on that side (and the corresponding module wiring is skipped).
		 * The junction service body is always emitted regardless. Defaults
		 * to `{ left: true, right: true }`.
		 */
		expose_on_parent: z
			.object({
				left: z.boolean().optional().default(true),
				right: z.boolean().optional().default(true),
			})
			.optional()
			.default({ left: true, right: true }),
	})
	.strict()
	.refine((d) => d.between[0] !== d.between[1], {
		message: '`between` endpoints must be distinct',
		path: ['between'],
	})
	.refine(
		(d) => {
			const fieldNames = Object.keys(d.fields ?? {});
			return !fieldNames.some((n) => BASE_JUNCTION_FIELD_NAMES.has(n));
		},
		{
			message:
				'`fields:` block redeclares a reserved BaseJunctionFields column ' +
				'(is_primary, started_at, ended_at, sourced_from, confidence, matched_at)',
			path: ['fields'],
		},
	);

export type JunctionDefinition = z.infer<typeof JunctionDefinitionSchema>;

// ============================================================================
// Validation Helpers
// ============================================================================

export function validateJunctionDefinition(data: unknown): JunctionDefinition {
	return JunctionDefinitionSchema.parse(data);
}

export function safeValidateJunctionDefinition(data: unknown): {
	success: boolean;
	data?: JunctionDefinition;
	error?: z.ZodError;
} {
	const result = JunctionDefinitionSchema.safeParse(data);
	if (result.success) {
		return { success: true, data: result.data };
	}
	return { success: false, error: result.error };
}
