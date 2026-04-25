/**
 * Sync subsystem — `WebhookChangeSource<T>` primitive (#226-4, ADR-033).
 *
 * Generic webhook-mode `IChangeSource<T>` implementation parameterized by a
 * parsed `DetectionConfig` (webhook mode) and a consumer-supplied
 * `WebhookFetchCallback<T>` that iterates a consumer-owned inbound staging
 * queue. The primitive owns:
 *
 *   - canonical `Change<T>.source = 'webhook'` stamping;
 *   - `dedupKey` derivation from the configured `webhook.eventIdField` on
 *     the emitted record;
 *   - `externalId` derivation from the mapping table's `external_id` target
 *     (mirrors `PollChangeSource`);
 *   - middleware-chain composition via the locked `ChangeMiddleware<T>` shape
 *     (#226-1) — same composition seam as the poll primitive.
 *
 * The primitive is **passive**: it iterates whatever the consumer-owned
 * queue yields. It does NOT synchronously drive the orchestrator, does NOT
 * own a transport, and does NOT manage acks. The inbound staging table
 * schema is consumer-owned and deferred per ADR-0002 §Phase 4 — the
 * `WebhookFetchCallback<T>` is the queue contract the consumer injects.
 *
 * Shape locks (decision memo Q5, mirrored from poll primitive):
 *   - `WebhookFetchContext = { subscription, cursor }` — explicitly NO
 *     `userId` / `tenantId`. Run-scope identity is closed over by the
 *     consumer at queue construction or resolved inside the callback via
 *     consumer services. There are no `filters` on the webhook context —
 *     filtering is done at registration / on the staging row, not at the
 *     port seam (the queue is already filtered by the time the primitive
 *     iterates).
 *
 * Long-lived streaming CDC primitives (SFDC Pub-Sub gRPC, Debezium/Kafka,
 * Postgres logical replication) are deferred to `#226-8` — they need a
 * fundamentally different lifecycle (`subscribe(onChange, onError)`,
 * server-paced backpressure, ack-on-yield) and shouldn't be retrofitted
 * into either this primitive or the poll primitive.
 */

import type { DetectionConfig } from './detection-config.schema';
import type {
  Change,
  IChangeSource,
  SyncSubscriptionView,
} from './sync-change-source.protocol';
import type {
  ChangeIterator,
  ChangeMiddleware,
} from './sync-middleware.protocol';

// ============================================================================
// Cursor + queue callback shapes
// ============================================================================

/**
 * Opaque webhook cursor shape. Webhook mode typically has a cursor of
 * `{ ts: ISO-string }` (last drained staging-row timestamp) but the
 * primitive treats it as opaque. Consumer-owned queue iterators interpret
 * it however the staging schema needs.
 */
export type WebhookCursor = unknown;

/**
 * Context the primitive forwards to the queue iterator. Locked to exactly
 * two fields per the same Q5 reasoning that locks `PollFetchContext` — no
 * `userId` / `tenantId`.
 */
export interface WebhookFetchContext {
  readonly subscription: SyncSubscriptionView;
  readonly cursor: WebhookCursor | null;
}

/**
 * Consumer-supplied queue iterator. Returns an async iterable of
 * `{ record }` pairs — the consumer drains the inbound staging queue and
 * emits already-mapped canonical records `T`. The primitive stamps
 * `source: 'webhook'` and `dedupKey` from the record's configured
 * `webhook.eventIdField`; the consumer is the one who decided when a
 * staging row is "ready" to drain.
 *
 * Webhook mode has no per-record cursor advance — the staging-row drain
 * order is consumer policy (FIFO by ingestion timestamp, by event id, etc.)
 * and is opaque to the primitive. The orchestrator's last-yielded cursor
 * is whatever the consumer chooses to surface, if anything.
 */
export type WebhookFetchCallback<T> = (
  ctx: WebhookFetchContext,
) => AsyncIterable<{ record: T; cursor?: WebhookCursor }>;

// ============================================================================
// Constructor options
// ============================================================================

export interface WebhookChangeSourceOptions<T> {
  /** Consumer-supplied inbound queue iterator. */
  readonly queue: WebhookFetchCallback<T>;
  /**
   * Parsed detection config. MUST be `mode: 'webhook'`; the constructor
   * throws if a poll config is supplied. Codegen-emitted factories call
   * `DetectionConfigSchema.parse(...)` upstream so this is a safety net,
   * not the primary validation point.
   */
  readonly config: DetectionConfig;
  /**
   * Optional middleware chain. Same shape and composition rules as
   * `PollChangeSource` — first element is the outermost layer.
   */
  readonly middlewares?: ReadonlyArray<ChangeMiddleware<T>>;
  /**
   * Optional human label for run logs (e.g. `'stripe-webhook-charge'`).
   * Defaults to a derived label based on the mapping at construction.
   */
  readonly label?: string;
}

// ============================================================================
// WebhookChangeSource<T>
// ============================================================================

export class WebhookChangeSource<T> implements IChangeSource<T> {
  public readonly label: string;

  private readonly queue: WebhookFetchCallback<T>;
  private readonly externalIdSourceField: string;
  private readonly eventIdSourceField: string;
  private readonly composed: ChangeIterator<T>;

  constructor(opts: WebhookChangeSourceOptions<T>) {
    if (opts.config.mode !== 'webhook') {
      throw new Error(
        `WebhookChangeSource requires DetectionConfig.mode === 'webhook'; got '${(opts.config as { mode: string }).mode}'`,
      );
    }
    const config = opts.config;

    // Field mapping: locate the canonical `external_id` target — mirrors the
    // poll primitive's contract. Adapters emit records already-mapped; the
    // primitive needs to know which key on T carries the external id so it
    // can stamp `Change.externalId`.
    const externalIdMapping = config.mapping.find(
      (m) => m.target === 'external_id',
    );
    if (!externalIdMapping) {
      throw new Error(
        "WebhookChangeSource: DetectionConfig.mapping must include an entry with target 'external_id' so emitted Change<T>.externalId can be populated",
      );
    }
    this.externalIdSourceField = externalIdMapping.target;
    this.eventIdSourceField = config.webhook.eventIdField;

    this.queue = opts.queue;

    this.label =
      opts.label ?? `webhook-change-source:${externalIdMapping.source}`;

    // Compose middleware chain — same shape as PollChangeSource.
    const inner: ChangeIterator<T> = (sub, cur) => this.fetch(sub, cur);
    const middlewares = opts.middlewares ?? [];
    this.composed = middlewares.reduceRight<ChangeIterator<T>>(
      (next, mw) => mw(next),
      inner,
    );
  }

  listChanges(
    subscription: SyncSubscriptionView,
    cursor: unknown | null,
  ): AsyncIterable<Change<T>> {
    return this.composed(subscription, cursor);
  }

  private async *fetch(
    subscription: SyncSubscriptionView,
    cursor: unknown | null,
  ): AsyncIterable<Change<T>> {
    const ctx: WebhookFetchContext = {
      subscription,
      cursor: cursor as WebhookCursor | null,
    };

    for await (const { record, cursor: nextCursor } of this.queue(ctx)) {
      const externalIdRaw = (record as Record<string, unknown>)[
        this.externalIdSourceField
      ];
      if (typeof externalIdRaw !== 'string' || externalIdRaw.length === 0) {
        throw new Error(
          `WebhookChangeSource: record missing string '${this.externalIdSourceField}' — emitted records MUST carry the canonical external id keyed by the mapping target`,
        );
      }
      const eventIdRaw = (record as Record<string, unknown>)[
        this.eventIdSourceField
      ];
      if (typeof eventIdRaw !== 'string' || eventIdRaw.length === 0) {
        throw new Error(
          `WebhookChangeSource: record missing string '${this.eventIdSourceField}' — webhook records MUST carry the event id (DetectionConfig.webhook.eventIdField) so Change<T>.dedupKey can be populated`,
        );
      }

      const change: Change<T> = {
        externalId: externalIdRaw,
        // Webhook mode cannot distinguish create vs. update vs. delete on
        // its own — the orchestrator's diff stage handles classification.
        // Tombstone / soft-delete detection is consumer-driven (same as
        // poll mode — see ADR-033).
        operation: 'updated',
        record,
        cursor: nextCursor ?? null,
        source: 'webhook',
        dedupKey: eventIdRaw,
      };
      yield change;
    }
  }
}
