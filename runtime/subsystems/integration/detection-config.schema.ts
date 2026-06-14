/**
 * Integration subsystem — DetectionConfig schema (#226-1)
 *
 * Canonical Zod schema for per-entity integration detection config. The schema is
 * the single source of truth for filter/mapping shape and is consumed by:
 *
 *   1. Runtime primitives — `PollChangeSource<T>`, `WebhookChangeSource<T>`
 *      (#226-3, #226-4) accept a parsed `DetectionConfig` at construction.
 *   2. Codegen — `src/schema/entity-definition.schema.ts` (#226-6) imports
 *      this schema so per-entity YAML `detection:` blocks validate against
 *      the same shape the runtime enforces.
 *
 * Locked decisions (see ADR-033 + decision memo Q1–Q6):
 *   - Filter vocabulary is flat AND of `{ field, op, value }` triples; richer
 *     boolean expressions (OR / NOT / nested) are deferred per epic open Q3.
 *   - Cursor strategy is a tagged union over the six shapes the modes need
 *     (`systemModstamp`, `replayId`, `timestamp`, `eventId`, plus `historyId`
 *     and `syncToken` added in RFC-0003). Each strategy types its cursor
 *     internally; the orchestrator persists what the iterator last yielded
 *     (integration skill rule 2). Divisibility per strategy is tabled in
 *     `CURSOR_DIVISIBILITY` below.
 *   - `mode: 'poll'` may opt into `provenance: 'cdc'` so Stripe-style event
 *     endpoints (mechanically a poll, semantically CDC) reuse the poll
 *     primitive while emitting `Change<T>.source = 'cdc'`. Long-lived
 *     streaming CDC (SFDC Pub-Sub, Debezium) is a separate primitive
 *     deferred to #226-8.
 *   - `webhook` mode's `eventIdField` is optional: `WebhookChangeSource<T>`
 *     prefers an `eventId` yielded by the queue iterator and falls back to the
 *     `eventIdField` record extraction (precedence: yielded eventId >
 *     eventIdField extraction > undefined dedupKey).
 */
import { z } from "zod";

// ============================================================================
// Field mapping — provider field → canonical target
// ============================================================================

/**
 * Maps a single provider field onto the canonical record. `transform` is an
 * opt-in tag the adapter callback may inspect (`date-iso`, `decimal-string`,
 * etc.); the schema does not enumerate transforms — adapters interpret them.
 */
export const FieldMappingSchema = z.object({
	source: z.string().min(1),
	target: z.string().min(1),
	transform: z.string().min(1).optional(),
});

export type FieldMapping = z.infer<typeof FieldMappingSchema>;

// ============================================================================
// Resolved filter — flat-AND triple
// ============================================================================

/**
 * A single resolved filter clause applied at fetch time. `value` is `unknown`
 * to admit primitives, arrays (for `in` / `nin`), and dates as ISO strings —
 * adapters interpret per provider.
 */
export const ResolvedFilterSchema = z.object({
	field: z.string().min(1),
	op: z.enum(["eq", "neq", "in", "nin", "gt", "gte", "lt", "lte"]),
	value: z.unknown(),
});

export type ResolvedFilter = z.infer<typeof ResolvedFilterSchema>;

// ============================================================================
// Cursor strategy — tagged union over the six shapes the modes need
// ============================================================================

const SystemModstampCursorSchema = z.object({
	kind: z.literal("systemModstamp"),
	field: z.string().min(1),
});

const ReplayIdCursorSchema = z.object({
	kind: z.literal("replayId"),
	field: z.string().min(1),
});

const TimestampCursorSchema = z.object({
	kind: z.literal("timestamp"),
	field: z.string().min(1),
});

const EventIdCursorSchema = z.object({
	kind: z.literal("eventId"),
	field: z.string().min(1),
});

/**
 * Gmail `historyId` (RFC-0003 §3) — an opaque, atomic vendor token. The next
 * watermark only exists at end-of-walk; there is no resumable mid-walk value.
 * `field` is metadata for codegen/adapters (the response key the token lives on).
 */
const HistoryIdCursorSchema = z.object({
	kind: z.literal("historyId"),
	field: z.string().min(1),
});

/**
 * Google Calendar `syncToken` (RFC-0003 §3) — an opaque, atomic sync token,
 * same divisibility profile as `historyId`.
 */
const SyncTokenCursorSchema = z.object({
	kind: z.literal("syncToken"),
	field: z.string().min(1),
});

export const CursorStrategySchema = z.discriminatedUnion("kind", [
	SystemModstampCursorSchema,
	ReplayIdCursorSchema,
	TimestampCursorSchema,
	EventIdCursorSchema,
	HistoryIdCursorSchema,
	SyncTokenCursorSchema,
]);

export type CursorStrategy = z.infer<typeof CursorStrategySchema>;

// ============================================================================
// Cursor divisibility (RFC-0003 §3)
// ============================================================================

/**
 * Whether a cursor strategy is *divisible* — a property of the strategy, not
 * the read primitive. Divisible cursors are sortable/monotonic watermarks whose
 * value is meaningful AS OF any single record (HubSpot `systemModstamp`, a
 * `timestamp` field, a Salesforce CDC `replayId`); the read primitive may
 * checkpoint per-ref mid-walk, so a crash resumes from the last delivered ref.
 *
 * Atomic cursors are opaque vendor tokens (Gmail `historyId`, Calendar
 * `syncToken`, a generic `eventId`) whose next value only exists at end-of-walk.
 * The primitive must withhold per-ref cursors and emit the token only at a safe
 * boundary, so an interrupted run never persists an unresumable mid-walk token
 * (it resumes all-or-nothing from the prior token — see `IncrementalReadBase`).
 *
 * `eventId` is classified atomic conservatively: a generic opaque id is treated
 * all-or-nothing unless a concrete strategy proves it monotonically resumable.
 */
export const CURSOR_DIVISIBILITY: Readonly<
	Record<CursorStrategy["kind"], boolean>
> = {
	systemModstamp: true,
	timestamp: true,
	replayId: true,
	eventId: false,
	historyId: false,
	syncToken: false,
};

/** Predicate form of {@link CURSOR_DIVISIBILITY}. */
export function isDivisibleCursor(kind: CursorStrategy["kind"]): boolean {
	return CURSOR_DIVISIBILITY[kind];
}

// ============================================================================
// Mode-specific blocks
// ============================================================================

/**
 * Poll-mode block. `provenance: 'cdc'` opts the poll primitive into stamping
 * `Change<T>.source = 'cdc'` and populating `dedupKey` from the cursor's
 * `field` — used for Stripe-style event endpoints. Defaults to `'poll'`.
 */
export const PollDetectionSchema = z.object({
	cursor: CursorStrategySchema,
	provenance: z.enum(["poll", "cdc"]).optional(),
});

export type PollDetection = z.infer<typeof PollDetectionSchema>;

/**
 * Webhook-mode block. `eventIdField`, when present, names the field on the
 * emitted canonical record that `WebhookChangeSource<T>` reads to set
 * `Change<T>.dedupKey` — used only as the fallback when the queue iterator
 * does NOT yield an `eventId` alongside the record.
 *
 * `eventIdField` is **optional**: a queue iterator that always yields an
 * `eventId` (vendor delivery metadata, the preferred channel) need not declare
 * a record field for it. dedupKey precedence is: yielded `eventId` >
 * `eventIdField` record extraction > undefined.
 */
export const WebhookDetectionSchema = z.object({
	eventIdField: z.string().min(1).optional(),
});

export type WebhookDetection = z.infer<typeof WebhookDetectionSchema>;

// ============================================================================
// DetectionConfig — top-level discriminated union over `mode`
// ============================================================================

const PollModeSchema = z.object({
	mode: z.literal("poll"),
	poll: PollDetectionSchema,
	mapping: z.array(FieldMappingSchema).min(1),
	filters: z.array(ResolvedFilterSchema).default([]),
});

const WebhookModeSchema = z.object({
	mode: z.literal("webhook"),
	webhook: WebhookDetectionSchema,
	mapping: z.array(FieldMappingSchema).min(1),
	filters: z.array(ResolvedFilterSchema).default([]),
});

/**
 * Top-level detection config. Discriminated on `mode` so the relevant
 * mode-block (poll/webhook) is structurally required for that mode. CDC as a
 * long-lived streaming primitive is deferred (#226-8); CDC-as-provenance
 * (Stripe-style event endpoints) is expressed via `mode: 'poll'` with
 * `poll.provenance: 'cdc'`.
 */
export const DetectionConfigSchema = z.discriminatedUnion("mode", [
	PollModeSchema,
	WebhookModeSchema,
]);

export type DetectionConfig = z.infer<typeof DetectionConfigSchema>;
