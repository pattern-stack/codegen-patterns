/**
 * Integration subsystem — `WebhookChangeSource<T>` primitive (#226-4, ADR-033).
 *
 * Generic webhook-mode `IChangeSource<T>` implementation parameterized by a
 * parsed `DetectionConfig` (webhook mode) and a consumer-supplied
 * `WebhookFetchCallback<T>` that iterates a consumer-owned inbound staging
 * queue. The primitive owns:
 *
 *   - canonical `Change<T>.source = 'webhook'` stamping;
 *   - `dedupKey` derivation, preferring the `eventId` yielded alongside the
 *     record by the queue iterator, and falling back to the configured
 *     `webhook.eventIdField` on the emitted record when no `eventId` is yielded
 *     (precedence: yielded `eventId` > `eventIdField` record extraction >
 *     undefined `dedupKey`);
 *   - `externalId` derivation: the mapping entry whose `target === 'external_id'`
 *     names — via its `source` — the field on the emitted record that carries
 *     the canonical external id (mirrors `PollChangeSource`);
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

import type { DetectionConfig } from "./detection-config.schema";
import type {
	Change,
	IChangeSource,
	IntegrationSubscriptionView,
} from "./integration-change-source.protocol";
import type {
	ChangeIterator,
	ChangeMiddleware,
} from "./integration-middleware.protocol";

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
	readonly subscription: IntegrationSubscriptionView;
	readonly cursor: WebhookCursor | null;
}

/**
 * Consumer-supplied queue iterator. Returns an async iterable of
 * `{ record, eventId?, cursor? }` tuples — the consumer drains the inbound
 * staging queue and emits already-mapped canonical records `T`. The primitive
 * stamps `source: 'webhook'` and derives `dedupKey` with this precedence:
 *
 *   1. the yielded `eventId` (vendor delivery metadata — the queue is the
 *      right channel for it: a vendor's event id should never need a field
 *      on the vendor-neutral canonical record);
 *   2. else the record field named by `webhook.eventIdField`, when configured;
 *   3. else `undefined`.
 *
 * Yielding `eventId` is the safe channel when one canonical record identity
 * (the `external_id`) can recur across distinct vendor events in a single
 * drain batch — e.g. a message create and its later edit share an
 * `external_id` but are different events. Reading dedup identity off the
 * record (`eventIdField`) collapses those into one `dedupKey`; the yielded
 * `eventId` keeps them distinct. The consumer is the one who decided when a
 * staging row is "ready" to drain.
 *
 * Webhook mode has no per-record cursor advance — the staging-row drain
 * order is consumer policy (FIFO by ingestion timestamp, by event id, etc.)
 * and is opaque to the primitive. The orchestrator's last-yielded cursor
 * is whatever the consumer chooses to surface, if anything.
 */
export type WebhookFetchCallback<T> = (
	ctx: WebhookFetchContext,
) => AsyncIterable<{ record: T; eventId?: string; cursor?: WebhookCursor }>;

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
	/**
	 * Record field carrying the event id, when `webhook.eventIdField` is
	 * configured. Used only as the fallback when the queue iterator does NOT
	 * yield an `eventId` — see {@link WebhookFetchCallback} for the precedence.
	 */
	private readonly eventIdSourceField: string | undefined;
	private readonly composed: ChangeIterator<T>;

	constructor(opts: WebhookChangeSourceOptions<T>) {
		if (opts.config.mode !== "webhook") {
			throw new Error(
				`WebhookChangeSource requires DetectionConfig.mode === 'webhook'; got '${(opts.config as { mode: string }).mode}'`,
			);
		}
		const config = opts.config;

		// Field mapping: locate the entry whose canonical `target` is `external_id`
		// — mirrors the poll primitive's contract. Adapters emit records
		// already-mapped; the primitive needs to know which key on T carries the
		// external id so it can stamp `Change.externalId`. That key is the
		// mapping's `source` (the field on the emitted record), NOT its `target`
		// (the canonical column) — they differ whenever the canonical record is
		// vendor-neutral camelCase (e.g. `source: 'externalId'` → `target: 'external_id'`).
		const externalIdMapping = config.mapping.find(
			(m) => m.target === "external_id",
		);
		if (!externalIdMapping) {
			throw new Error(
				"WebhookChangeSource: DetectionConfig.mapping must include an entry with target 'external_id' so emitted Change<T>.externalId can be populated",
			);
		}
		this.externalIdSourceField = externalIdMapping.source;
		this.eventIdSourceField = config.webhook.eventIdField;
		// `eventIdField` is optional (a callback that always yields `eventId` need
		// not declare one); `undefined` here just disables the fallback extraction.

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
		subscription: IntegrationSubscriptionView,
		cursor: unknown | null,
	): AsyncIterable<Change<T>> {
		return this.composed(subscription, cursor);
	}

	private async *fetch(
		subscription: IntegrationSubscriptionView,
		cursor: unknown | null,
	): AsyncIterable<Change<T>> {
		const ctx: WebhookFetchContext = {
			subscription,
			cursor: cursor as WebhookCursor | null,
		};

		for await (const {
			record,
			eventId: yieldedEventId,
			cursor: nextCursor,
		} of this.queue(ctx)) {
			const externalIdRaw = (record as Record<string, unknown>)[
				this.externalIdSourceField
			];
			if (typeof externalIdRaw !== "string" || externalIdRaw.length === 0) {
				throw new Error(
					`WebhookChangeSource: record missing string '${this.externalIdSourceField}' — emitted records MUST carry the canonical external id keyed by the mapping source`,
				);
			}

			// dedupKey precedence: yielded `eventId` > `eventIdField` record
			// extraction > undefined. The yielded id is vendor delivery metadata
			// (the right channel for it), and keeps distinct vendor events for the
			// same `external_id` (e.g. a message and its edit) from collapsing to
			// one dedupKey — which a record-field extraction would do.
			const dedupKey = this.deriveDedupKey(yieldedEventId, record);

			const change: Change<T> = {
				externalId: externalIdRaw,
				// Webhook mode cannot distinguish create vs. update vs. delete on
				// its own — the orchestrator's diff stage handles classification.
				// Tombstone / soft-delete detection is consumer-driven (same as
				// poll mode — see ADR-033).
				operation: "updated",
				record,
				cursor: nextCursor ?? null,
				source: "webhook",
				dedupKey,
			};
			yield change;
		}
	}

	/**
	 * Resolve `Change<T>.dedupKey` with the precedence: yielded `eventId` >
	 * `webhook.eventIdField` record extraction > `undefined`. A non-empty
	 * yielded `eventId` always wins; otherwise the configured field is read off
	 * the record (and must be a non-empty string when the field is configured);
	 * with neither, `dedupKey` is `undefined` (the orchestrator then has no
	 * delivery-level dedup signal for this change).
	 */
	private deriveDedupKey(
		yieldedEventId: string | undefined,
		record: T,
	): string | undefined {
		if (yieldedEventId !== undefined && yieldedEventId.length > 0) {
			return yieldedEventId;
		}
		if (this.eventIdSourceField === undefined) {
			return undefined;
		}
		const eventIdRaw = (record as Record<string, unknown>)[
			this.eventIdSourceField
		];
		if (typeof eventIdRaw !== "string" || eventIdRaw.length === 0) {
			throw new Error(
				`WebhookChangeSource: record missing string '${this.eventIdSourceField}' — a webhook record MUST carry the event id (DetectionConfig.webhook.eventIdField) so Change<T>.dedupKey can be populated, unless the queue iterator yields an 'eventId' alongside the record`,
			);
		}
		return eventIdRaw;
	}
}
