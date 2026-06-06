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

/**
 * Event tiers (AUDIT-1):
 *   - `domain` (default) — facts other components may react to. Bridge-eligible.
 *     Carries a `direction` and routes through the corresponding
 *     `events_*` pool.
 *   - `audit` — observational facts about the system itself (sync ran, feature
 *     used). NOT bridge-eligible. MUST have no `direction` and no `pool`.
 *
 * See `ai-docs/specs/issue-242/plan.md` for the full design and the EVT
 * skill (`.claude/skills/events/SKILL.md`) for the runtime contract.
 */
export const EVENT_TIERS = ["domain", "audit"] as const;
export type EventTier = (typeof EVENT_TIERS)[number];

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
const EventTierSchema = z.enum(EVENT_TIERS);
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

/**
 * Declarative time-based emission (ADR-039 — time as an event source). When an
 * event declares `schedule:`, the framework `EventScheduler` materialises one
 * `domain_events` row per (event type, slot) on this cadence; ADR-023's three
 * activation tiers (subscribe / `@JobHandler({ triggers })` / `publishAndStart`)
 * — unchanged — react. No new activation mechanism; time is just a third event
 * source peer to use-case publishes and webhook receivers.
 *
 * `every` is a duration string (`'1h'`, `'30m'`, `'15s'`, `'500ms'`, `'1d'`)
 * or a raw millisecond number — the slot length. Validated at codegen time;
 * re-checked at boot.
 */
const DURATION_RE = /^\s*[0-9]*\.?[0-9]+\s*(ms|s|m|h|d)\s*$/;

const ScheduleSchema = z
	.object({
		every: z.union([
			z
				.string()
				.regex(
					DURATION_RE,
					"schedule.every must be a duration like '1h', '30m', '15s', '500ms', '1d'",
				),
			z.number().positive().finite(),
		]),
		/** Epoch-anchored slot boundaries (default true). */
		align: z.boolean().optional().default(true),
		/** Backfill missed slots on recovery (default false → run once). */
		catchUp: z.boolean().optional().default(false),
		/** Upper bound on `catchUp` backfill (default 1000). */
		maxCatchUpSlots: z.number().int().positive().optional().default(1000),
	})
	.strict();

export type EventSchedule = z.infer<typeof ScheduleSchema>;

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
		tier: EventTierSchema.optional().default("domain"),
		direction: EventDirectionSchema.optional(),
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
		// ADR-039 — declarative time-based emission. Optional; when present the
		// platform emits this event on the given cadence (see ScheduleSchema).
		schedule: ScheduleSchema.optional(),
		version: z.number().int().min(1).optional().default(1),
		description: z.string().optional(),
	})
	.strict();

/**
 * Cross-field refinements (in order):
 *
 *   1. Tier invariants (AUDIT-1):
 *      a. `tier: 'audit'` ⇒ `pool` MUST be omitted.
 *      b. `tier: 'audit'` ⇒ `direction` MUST be omitted.
 *      c. `tier: 'domain'` ⇒ `direction` is required.
 *   2. `direction: change` ⇒ `aggregate` is required.
 *   3. `source` is only valid when `direction: inbound` (strict direction gating).
 *   4. `destination` is only valid when `direction: outbound` (strict direction gating).
 *   5. An explicit `pool` must match `DIRECTION_TO_POOL[direction]`.
 *
 * Strict gating on #3/#4 is a deliberate choice: silent acceptance breeds
 * drift. The ADR defines `source` as inbound-only and `destination` as
 * outbound-only.
 *
 * Refinements #2..#5 are domain-tier-only — audit events have no
 * direction/pool/aggregate/source/destination semantics.
 */
const EventDefinitionSchemaRefined = EventDefinitionSchemaCore.superRefine(
	(data, ctx) => {
		// AUDIT-1 — tier invariants. These run first because the rest of
		// the refinements assume domain semantics (direction populated).
		if (data.tier === "audit") {
			if (data.pool !== undefined) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Event '${data.type}' is tier:audit; pool MUST be omitted (got '${data.pool}'). Audit events have no pool. See ai-docs/specs/issue-242/plan.md §AUDIT-2.`,
					path: ["pool"],
				});
			}
			if (data.direction !== undefined) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Event '${data.type}' is tier:audit; direction MUST be omitted (got '${data.direction}'). Audit events have no direction. See ai-docs/specs/issue-242/plan.md §AUDIT-2.`,
					path: ["direction"],
				});
			}
			// ADR-039 — a scheduled event must DRIVE work, which means it needs a
			// direction/pool to reach the bridge; audit events route nowhere.
			// v1 keeps `schedule:` domain-tier only.
			if (data.schedule !== undefined) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Event '${data.type}' is tier:audit; 'schedule' is not allowed on audit events (they route to no pool and cannot drive the bridge). Make it a domain event with a direction. See ADR-039.`,
					path: ["schedule"],
				});
			}
			// Skip the domain-tier refinements below — they reference
			// `direction`, which is intentionally absent for audit.
			return;
		}

		// tier === 'domain' — direction must be present.
		if (data.direction === undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "'direction' is required when tier is 'domain'",
				path: ["direction"],
			});
			// Bail out — the remaining refinements all read `direction`
			// and would otherwise produce confusing cascade errors.
			return;
		}

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
 * Final schema: derive `pool` from `direction` when not explicitly set.
 *
 * After `parse()`:
 *   - Domain events (`tier === 'domain'`): `pool` and `direction` are both
 *     populated; `pool` is derived from `direction` when not explicit.
 *   - Audit events (`tier === 'audit'`): `pool` and `direction` both stay
 *     `undefined` — audit events have no routing fields by construction
 *     (mirrors the `domain_events` CHECK constraint, AUDIT-1).
 */
export const EventDefinitionSchema = EventDefinitionSchemaRefined.transform(
	(parsed) => {
		if (parsed.tier === "audit") {
			// Audit events: no pool/direction derivation. Both stay undefined.
			return parsed;
		}
		// tier === 'domain': direction is guaranteed present by the refinement.
		// Narrow the type for the lookup.
		const direction = parsed.direction as EventDirection;
		return {
			...parsed,
			pool: parsed.pool ?? DIRECTION_TO_POOL[direction],
		};
	},
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
