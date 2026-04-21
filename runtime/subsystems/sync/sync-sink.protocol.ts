/**
 * Sync subsystem — sync-sink protocol (port)
 *
 * Write surface for the generic orchestrator. One per canonical entity type.
 *
 * **Shape contract:** the sink speaks the *canonical* `TCanonical` externally
 * — `findByExternalId` returns a canonical-shaped view of local state
 * (columns projected to canonical field names) so the differ compares
 * like-for-like against `Change.record` from the adapter. Internal DB
 * mapping (canonical → local write, EAV dual-write, FK resolution) stays
 * inside the sink implementation.
 *
 * Implementations compose the entity's service + (when the entity has EAV)
 * `FieldValueService` inside a single transaction. ADR-13-revised.
 */
export interface ISyncSink<TCanonical> {
  /**
   * Canonical-shaped view of local state, or `null` when no local row exists.
   * Called once per change to source the diff's "before" side.
   */
  findByExternalId(
    userId: string,
    externalId: string,
  ): Promise<TCanonical | null>;

  /**
   * Insert-or-update by `external_id`. Must:
   *   - run EAV dual-write in a single transaction when the entity has `fields`
   *   - resolve FK references (e.g. `account_id` from `accountExternalId`)
   *     via a repository lookup
   *   - stamp `user_id` and `provider` from caller / context
   *   - tolerate re-entry (same record twice in a window = no-op)
   *
   * Returns the local row id and the canonical projection of the saved row
   * (so the orchestrator can record it on `sync_run_items.local_id`).
   *
   * `provider` is the adapter domain string (e.g. `'salesforce-crm'`,
   * `'hubspot-crm'`) persisted on the DB row. Passed from
   * `ExecuteSyncInput.provider`.
   */
  upsertByExternalId(
    userId: string,
    record: TCanonical,
    provider: string,
  ): Promise<{ id: string; saved: TCanonical }>;

  /**
   * Soft-delete by `external_id`. Called when `Change.operation === 'deleted'`.
   * Returns `null` when no local row exists (orchestrator records a no-op).
   */
  softDeleteByExternalId(
    userId: string,
    externalId: string,
  ): Promise<{ id: string } | null>;
}
