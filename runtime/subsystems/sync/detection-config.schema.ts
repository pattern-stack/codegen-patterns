/**
 * Sync subsystem — DetectionConfig schema (#226-1)
 *
 * Canonical Zod schema for per-entity sync detection config. The schema is
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
 *   - Cursor strategy is a tagged union over the four shapes the three modes
 *     need (`systemModstamp`, `replayId`, `timestamp`, `eventId`). Each
 *     strategy types its cursor internally; the orchestrator persists what
 *     the iterator last yielded (sync skill rule 2).
 *   - `mode: 'poll'` may opt into `provenance: 'cdc'` so Stripe-style event
 *     endpoints (mechanically a poll, semantically CDC) reuse the poll
 *     primitive while emitting `Change<T>.source = 'cdc'`. Long-lived
 *     streaming CDC (SFDC Pub-Sub, Debezium) is a separate primitive
 *     deferred to #226-8.
 *   - `webhook` mode requires `eventIdField` so `WebhookChangeSource<T>`
 *     can populate `Change<T>.dedupKey` from the inbound staging row.
 */
import { z } from 'zod';

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
  op: z.enum(['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte']),
  value: z.unknown(),
});

export type ResolvedFilter = z.infer<typeof ResolvedFilterSchema>;

// ============================================================================
// Cursor strategy — tagged union over the four shapes the modes need
// ============================================================================

const SystemModstampCursorSchema = z.object({
  kind: z.literal('systemModstamp'),
  field: z.string().min(1),
});

const ReplayIdCursorSchema = z.object({
  kind: z.literal('replayId'),
  field: z.string().min(1),
});

const TimestampCursorSchema = z.object({
  kind: z.literal('timestamp'),
  field: z.string().min(1),
});

const EventIdCursorSchema = z.object({
  kind: z.literal('eventId'),
  field: z.string().min(1),
});

export const CursorStrategySchema = z.discriminatedUnion('kind', [
  SystemModstampCursorSchema,
  ReplayIdCursorSchema,
  TimestampCursorSchema,
  EventIdCursorSchema,
]);

export type CursorStrategy = z.infer<typeof CursorStrategySchema>;

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
  provenance: z.enum(['poll', 'cdc']).optional(),
});

export type PollDetection = z.infer<typeof PollDetectionSchema>;

/**
 * Webhook-mode block. `eventIdField` names the column in the consumer-owned
 * inbound staging row that `WebhookChangeSource<T>` reads to set
 * `Change<T>.dedupKey`.
 */
export const WebhookDetectionSchema = z.object({
  eventIdField: z.string().min(1),
});

export type WebhookDetection = z.infer<typeof WebhookDetectionSchema>;

// ============================================================================
// DetectionConfig — top-level discriminated union over `mode`
// ============================================================================

const PollModeSchema = z.object({
  mode: z.literal('poll'),
  poll: PollDetectionSchema,
  mapping: z.array(FieldMappingSchema).min(1),
  filters: z.array(ResolvedFilterSchema).default([]),
});

const WebhookModeSchema = z.object({
  mode: z.literal('webhook'),
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
export const DetectionConfigSchema = z.discriminatedUnion('mode', [
  PollModeSchema,
  WebhookModeSchema,
]);

export type DetectionConfig = z.infer<typeof DetectionConfigSchema>;
