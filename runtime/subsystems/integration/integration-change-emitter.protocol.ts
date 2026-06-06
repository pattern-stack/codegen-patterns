/**
 * Integration subsystem — change-emitter protocol (port).
 *
 * `IIntegrationChangeEmitter` is the OPT-IN seam through which the generic
 * orchestrator (`ExecuteIntegrationUseCase`) publishes a typed, data-level
 * domain event after every sink write/soft-delete. It is the upstream-generalized
 * form of the per-sink event emission swe-brain hand-built (ADR-0009 Amendment B):
 * the differ already records `changed_fields` on `integration_run_items`, but
 * nothing publishes a "this entity changed" domain event for downstream
 * trigger→action consumers. This port closes that gap.
 *
 * ## Why a port (not a direct TypedEventBus call in the orchestrator)
 *
 * The orchestrator is strictly provider- AND entity-agnostic: `entityType` is a
 * bare `string` and the canonical record is generic `T` (see the use-case header
 * "No CRM bleed"). It therefore cannot know the typed event NAME
 * (`<entity>_created`) or the typed payload shape at compile time. The typed
 * knowledge lives at the per-entity assembly wiring (codegen knows the entity
 * name there). So the orchestrator depends on this thin, untyped port; codegen
 * binds a per-entity adapter that maps `(operation) → <entity>_<verb>` and calls
 * the project's generated `TypedEventBus.publish(...)` with the typed payload.
 *
 * ## Backwards compatibility
 *
 * The port is `@Optional()` on the orchestrator. Entities that do NOT opt in
 * (`integration.sink.emit_changes` absent/false) bind no emitter, so the
 * orchestrator's `this.emitter` is `undefined` and NOTHING is published — zero
 * behavior change. This is the invariant the snapshot fixture (which opts none
 * in) keeps green.
 *
 * ## Provenance — loop-breaking
 *
 * Every emitted event carries `source: 'integration'` in its payload. A future
 * write-back action (the Intervention layer in swe-brain terms) that subscribes
 * to these events can detect `source === 'integration'` and decline to echo the
 * change back to the vendor, breaking the inbound→writeback→inbound loop. This
 * is the data-layer counterpart of the loopback middleware that already guards
 * the read side (`createLoopbackMiddleware`).
 *
 * ## Transactionality
 *
 * `emitChange` receives the same `tx` the sink wrote under (when the sink exposes
 * one — today the sink owns its own transaction internally, so `tx` is reserved
 * for the future where the orchestrator drives the transaction). The generated
 * adapter forwards `tx` into `TypedEventBus.publish(type, id, payload, { tx })`,
 * so the event lands in the outbox iff the row commits (the events subsystem's
 * outbox guarantee). When `tx` is absent the publish is post-commit best-effort,
 * matching today's sink-owns-its-own-transaction reality.
 */

/** The data-level action the orchestrator observed. Maps onto the generated
 *  event verb: `created → <entity>_created`, `updated → <entity>_edited`
 *  (per swe-brain ADR-0009 B1 — `_edited`, never `_updated`),
 *  `deleted → <entity>_deleted` (tombstone soft-delete). `noop` never emits. */
export type IntegrationChangeAction = 'created' | 'updated' | 'deleted';

/**
 * The vendor-blind change descriptor the orchestrator hands the emitter. The
 * generated adapter reshapes this into the typed `<entity>_<verb>` payload
 * (`{ entityId, externalId, provider, changedFields?, source: 'integration' }`).
 */
export interface IntegrationChangeNotification {
  /** The local row id the sink wrote/soft-deleted (the domain aggregate id —
   *  becomes `aggregateId` on the published event AND `entityId` in the payload). */
  readonly entityId: string;
  /** Vendor-prefixed-or-bare external id the change keyed on (e.g. `slack:123`). */
  readonly externalId: string;
  /** Provider label from `ExecuteIntegrationInput.provider` (e.g. `'slack'`). */
  readonly provider: string;
  /** The observed action. `created`/`updated` come from the existing-row check;
   *  `deleted` from the soft-delete path. */
  readonly action: IntegrationChangeAction;
  /** The differ's structured per-field before/after map (the same value written
   *  to `integration_run_items.changed_fields`). Absent on deletes. */
  readonly changedFields?: Record<string, unknown>;
  /** Multi-tenant deployments thread the tenant id through to the event metadata. */
  readonly tenantId?: string | null;
  /** The transaction the sink wrote under, when the orchestrator drives one.
   *  Forwarded to `TypedEventBus.publish(..., { tx })` for the outbox guarantee.
   *  Reserved: today the sink owns its own transaction, so this is usually
   *  `undefined` and the publish is post-commit. Typed `unknown` here so the
   *  port stays free of a Drizzle type dependency (the generated adapter narrows). */
  readonly tx?: unknown;
}

/**
 * Post-upsert change-event emission port.
 *
 * One implementation per opted-in (entity, provider) assembly — codegen-emitted,
 * bound to `INTEGRATION_CHANGE_EMITTER` in that assembly module. The orchestrator
 * injects it `@Optional()`; an unbound token means no emission (back-compat).
 */
export interface IIntegrationChangeEmitter {
  /**
   * Publish the typed `<entity>_<verb>` domain event for one observed change.
   *
   * MUST be called only for real changes — the orchestrator never calls this on
   * a `noop` diff (canonical state unchanged) or a delete that hit no local row
   * (no tombstone created). Implementations should treat a call as "this thing
   * happened" and publish unconditionally.
   *
   * Errors are the orchestrator's concern: it wraps the call so a failed publish
   * does not abort the run (the row is already written; emission is best-effort
   * unless ridden on the outbox tx). See `ExecuteIntegrationUseCase.processChange`.
   */
  emitChange(notification: IntegrationChangeNotification): Promise<void>;
}
