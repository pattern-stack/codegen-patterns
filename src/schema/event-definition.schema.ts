import { z } from "zod";

/**
 * Event Definition Schema
 *
 * Describes a single `events/*.yaml` file. This is the codegen-side contract
 * for first-class event declarations (ADR-024 Phase 1, EVT-2). One file per
 * event; filename matches `type` (snake_case). Consumed by EVT-3 to emit
 * `runtime/subsystems/events/generated/` artifacts.
 *
 * Payload field types intentionally narrower than entity field types:
 * events are a wire format, not a database schema. `decimal`, `entity_ref`,
 * `string_array`, `enum` make no sense in an event payload.
 */

// ============================================================================
// Enums and constants
// ============================================================================

export const EVENT_DIRECTIONS = ["inbound", "change", "outbound"] as const;
export type EventDirection = (typeof EVENT_DIRECTIONS)[number];

export const EVENT_FIELD_TYPES = [
	"uuid",
	"string",
	"number",
	"boolean",
	"date",
	"json",
	"array",
] as const;
export type EventFieldType = (typeof EVENT_FIELD_TYPES)[number];

/**
 * Scalar types permitted as `items` of an `array` field. Intentionally narrower
 * than the full field-type set: nested arrays and nested objects inside a
 * payload array cross the line from "wire format" into "embedded schema" and
 * should be modelled either as a separate event or as a `json` blob.
 */
export const EVENT_ARRAY_ITEM_TYPES = [
	"uuid",
	"string",
	"number",
	"boolean",
	"date",
] as const;
export type EventArrayItemType = (typeof EVENT_ARRAY_ITEM_TYPES)[number];

export const RESERVED_EVENT_POOLS = [
	"events_inbound",
	"events_change",
	"events_outbound",
] as const;
export type EventPool = (typeof RESERVED_EVENT_POOLS)[number];

export const EVENT_BACKOFF_STRATEGIES = ["linear", "exponential"] as const;
export type EventBackoffStrategy = (typeof EVENT_BACKOFF_STRATEGIES)[number];

/**
 * Direction → default pool derivation. Each `direction` maps to exactly one
 * reserved pool; overrides must stay within the same category.
 */
export const DIRECTION_TO_POOL: Record<EventDirection, EventPool> = {
	inbound: "events_inbound",
	change: "events_change",
	outbound: "events_outbound",
};

// ============================================================================
// Sub-schemas
// ============================================================================

const EventDirectionSchema = z.enum(EVENT_DIRECTIONS);
const EventFieldTypeSchema = z.enum(EVENT_FIELD_TYPES);
const EventArrayItemTypeSchema = z.enum(EVENT_ARRAY_ITEM_TYPES);
const EventPoolSchema = z.enum(RESERVED_EVENT_POOLS);

/**
 * Per-payload-field metadata. `nullable: true` means the field may be `null`
 * on the wire; `description` is surfaced into the generated interface/Zod
 * schema as a JSDoc. `items` is required when `type: 'array'` and rejected
 * otherwise — enforces "array-ness is declared, item shape is declared"
 * without opening the door to arbitrary nesting.
 */
const EventPayloadFieldSchema = z
	.object({
		type: EventFieldTypeSchema,
		items: EventArrayItemTypeSchema.optional(),
		nullable: z.boolean().optional().default(false),
		description: z.string().optional(),
	})
	.strict()
	.superRefine((data, ctx) => {
		if (data.type === "array" && data.items === undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "'items' is required when type is 'array'",
				path: ["items"],
			});
		}
		if (data.type !== "array" && data.items !== undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `'items' is only valid when type is 'array' (got '${data.type}')`,
				path: ["items"],
			});
		}
	});

export type EventPayloadField = z.infer<typeof EventPayloadFieldSchema>;

/**
 * Retry metadata hints surfaced to the drain loop. Default applied at parent
 * level (see `EventDefinitionSchemaCore`).
 */
const RetrySchema = z
	.object({
		attempts: z.number().int().min(0).max(20),
		backoff: z.enum(EVENT_BACKOFF_STRATEGIES),
	})
	.strict();

export type EventRetry = z.infer<typeof RetrySchema>;

// ============================================================================
// Top-level schema
// ============================================================================

const SNAKE_CASE_RE = /^[a-z][a-z0-9_]*$/;

const EventDefinitionSchemaCore = z
	.object({
		type: z
			.string()
			.regex(
				SNAKE_CASE_RE,
				"Event type must be snake_case starting with a letter",
			),
		direction: EventDirectionSchema,
		pool: EventPoolSchema.optional(),
		aggregate: z.string().regex(SNAKE_CASE_RE).optional(),
		source: z.string().min(1).optional(),
		destination: z.string().min(1).optional(),
		payload: z
			.record(
				z
					.string()
					.regex(SNAKE_CASE_RE, "Payload keys must be snake_case"),
				EventPayloadFieldSchema,
			)
			.default({}),
		retry: RetrySchema.optional().default({
			attempts: 3,
			backoff: "exponential",
		}),
		version: z.number().int().min(1).optional().default(1),
		description: z.string().optional(),
	})
	.strict();

/**
 * Cross-field refinements (in order):
 *
 *   1. `direction: change` ⇒ `aggregate` is required.
 *   2. `source` is only valid when `direction: inbound` (strict direction gating).
 *   3. `destination` is only valid when `direction: outbound` (strict direction gating).
 *   4. An explicit `pool` must match `DIRECTION_TO_POOL[direction]`.
 *
 * Strict gating on #2/#3 is a deliberate choice: silent acceptance breeds
 * drift. The ADR defines `source` as inbound-only and `destination` as
 * outbound-only.
 */
const EventDefinitionSchemaRefined = EventDefinitionSchemaCore.superRefine(
	(data, ctx) => {
		if (data.direction === "change" && !data.aggregate) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "'aggregate' is required when direction is 'change'",
				path: ["aggregate"],
			});
		}

		if (data.source !== undefined && data.direction !== "inbound") {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `'source' is only valid when direction is 'inbound' (got '${data.direction}')`,
				path: ["source"],
			});
		}

		if (data.destination !== undefined && data.direction !== "outbound") {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `'destination' is only valid when direction is 'outbound' (got '${data.direction}')`,
				path: ["destination"],
			});
		}

		if (data.pool !== undefined) {
			const expected = DIRECTION_TO_POOL[data.direction];
			if (data.pool !== expected) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `pool '${data.pool}' is inconsistent with direction '${data.direction}' (expected '${expected}')`,
					path: ["pool"],
				});
			}
		}
	},
);

/**
 * Final schema: derive `pool` from `direction` when not explicitly set. After
 * `parse()`, every `EventDefinition` has `pool` populated.
 */
export const EventDefinitionSchema = EventDefinitionSchemaRefined.transform(
	(parsed) => ({
		...parsed,
		pool: parsed.pool ?? DIRECTION_TO_POOL[parsed.direction],
	}),
);

export type EventDefinition = z.infer<typeof EventDefinitionSchema>;

// ============================================================================
// Validation Helpers
// ============================================================================

export function validateEventDefinition(data: unknown): EventDefinition {
	return EventDefinitionSchema.parse(data);
}

export function safeValidateEventDefinition(data: unknown): {
	success: boolean;
	data?: EventDefinition;
	error?: z.ZodError;
} {
	const result = EventDefinitionSchema.safeParse(data);
	if (result.success) {
		return { success: true, data: result.data };
	}
	return { success: false, error: result.error };
}
