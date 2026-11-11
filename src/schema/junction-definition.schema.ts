import { z } from 'zod';
import { junctionName } from '../config/junction-naming.js';
import { TABLE_NAME_IS_NOT_A_KEY, TABLE_NAME_PATTERN, TABLE_PREFIX_PATTERN } from '../config/table-naming.js';
import { BASE_JUNCTION_FIELD_NAMES } from '../patterns/library/base-junction-fields.js';
import { FieldDefinitionSchema } from './entity-definition.schema.js';

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
 * The identity role (`role` with `choices:`) is always NOT NULL — it is part of
 * the composite key — so `nullable: false` on it restates the rule. The entity
 * field rule would read that as "NOT NULL with no default" and refuse it, so
 * the redundant key is dropped before the field schema sees it.
 */
function stripIdentityRoleNotNull(fields: unknown): unknown {
	if (!fields || typeof fields !== 'object') return fields;
	const role = (fields as Record<string, unknown>).role as Record<string, unknown> | undefined;
	if (!role || typeof role !== 'object' || role.nullable !== false) return fields;
	if (!Array.isArray(role.choices) || role.choices.length === 0) return fields;
	const { nullable: _redundant, ...rest } = role;
	return { ...(fields as Record<string, unknown>), role: rest };
}

/**
 * Top-level junction YAML shape.
 *
 *   pattern: Junction
 *   between: [opportunity, contact]
 *   temporal: true        # optional, default true
 *   sourced: true         # optional, default true
 *   is_primary: true      # optional, default true
 *   timestamps: true      # optional, default true
 *   fields:
 *     role:
 *       type: enum
 *       choices: [champion, decision_maker, influencer]
 *   queries:
 *     - by: [opportunity_id]
 *
 * Payload fields parse against the entity `FieldDefinitionSchema` — the same
 * field contract, so `required`, `nullable`, `default`, `foreign_key`, `index`
 * and `choices` mean what they mean on an entity, and the junction template
 * renders them with the entity column builder (#740). An unknown key
 * (`values:` for `choices:`, #690) is a parse error, not a dropped column.
 *
 * `role` is special only when it has `choices:` — then it is the junction's
 * identity enum (always NOT NULL, part of the composite key). A `role`
 * without `choices:` is an ordinary payload column of its declared type (#7
 * of the dealbrain dogfood: it used to be deleted silently).
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
		 * The SQL table name (TABLE-0) — same two keys, same rule as an entity's
		 * (`src/config/table-naming.ts`): `table` is the literal SQL name,
		 * used verbatim; `table_prefix` overrides the project's `tables.prefix`
		 * (`''` opts out). Neither changes the junction's name, export, folder or
		 * classes, which stay derived from `between:`.
		 */
		table: z
			.string()
			.regex(TABLE_NAME_PATTERN, 'table must be a lowercase snake_case SQL table name')
			.optional(),
		/** Not a key — declared so writing it fails naming `table:`. */
		table_name: z.never({ invalid_type_error: TABLE_NAME_IS_NOT_A_KEY }).optional(),
		table_prefix: z
			.string()
			.regex(TABLE_PREFIX_PATTERN, "table_prefix must be empty or lowercase snake_case (e.g. 'crm__')")
			.optional(),

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
		fields: z
			.preprocess(stripIdentityRoleNotNull, z.record(z.string(), FieldDefinitionSchema))
			.optional(),

		/**
		 * Emit the BaseJunctionFields `is_primary` column (and the service's
		 * `setPrimary` + the parents' `<plural>SetPrimary` fan-out). Default
		 * true. `false` adopts a link table that has no such column.
		 */
		is_primary: z.boolean().optional().default(true),

		/**
		 * Emit `created_at` / `updated_at` and stamp them on write. Default
		 * true. `false` adopts a link table without them; the columns may then
		 * be declared as ordinary `fields:` if the table has only one of them.
		 */
		timestamps: z.boolean().optional().default(true),

		/**
		 * Declarative queries — same syntax as entity queries. Shape is
		 * validated downstream by the codegen layer.
		 */
		queries: z.array(z.any()).optional(),

		/**
		 * Per-side opt-out for parent-service fan-out (CGP-60). When a side
		 * is `false`, that endpoint's own service + module templates render
		 * no fan-out for this junction (JUNC-0, #678 —
		 * `templates/_shared/junction-fan-out.mjs`). The junction service body
		 * is always emitted regardless. Defaults to `{ left: true, right: true }`.
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
	.refine((d) => !(d.table !== undefined && d.table_prefix !== undefined), {
		message:
			"'table' and 'table_prefix' are mutually exclusive — table is the literal SQL name and takes no prefix",
		path: ['table_prefix'],
	})
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
	)
	.superRefine((d, ctx) => {
		const fields = d.fields ?? {};
		for (const [name, field] of Object.entries(fields)) {
			const at = (key: string) => ['fields', name, key];
			if (d.timestamps && (name === 'created_at' || name === 'updated_at')) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `'${name}' is emitted by the junction's timestamps — set 'timestamps: false' to declare it as a field`,
					path: ['fields', name],
				});
			}
			// The junction template has no file loader and no polymorphic columns.
			if (field.choices_from !== undefined) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "'choices_from' is not supported on a junction field — list the values inline with 'choices:'",
					path: at('choices_from'),
				});
			}
			if (field.type === 'entity_ref') {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "'entity_ref' is not supported on a junction field",
					path: at('type'),
				});
			}
		}
		// The identity role is part of the composite primary key: it cannot be NULL.
		const role = fields.role;
		if (role?.choices?.length && role.nullable === true) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message:
					"a junction 'role' with 'choices:' is part of the composite primary key and cannot be nullable",
				path: ['fields', 'role', 'nullable'],
			});
		}
	});

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

// ============================================================================
// Naming
// ============================================================================

/**
 * A junction's name is its pairing, in declaration order:
 * `between: [opportunity, contact]` → `opportunity_contact`.
 *
 * There is no YAML override — `JunctionDefinitionSchema` is `.strict()` and
 * declares no `name` key, so the pairing is the only source (GATE-1, #599).
 * Lives here, next to the schema that makes that true, because two readers now
 * depend on it: the barrel generator (which names the emitted module) and
 * CAP-2's role validator (which resolves a `many` role's `via:`).
 */
export function deriveJunctionName(def: { between: [string, string] }): string {
	return junctionName(def.between);
}
