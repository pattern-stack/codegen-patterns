/**
 * Sync subsystem — cursor-store protocol (port)
 *
 * Subscription-addressed cursor persistence. The subscription row IS the
 * cursor owner — addressable by id, scoped by
 * `(integration, adapter, domain, external_ref)` at the subscription level.
 *
 * Cursor shape is opaque at this seam; strategies type it internally
 * (polling: `{ systemModstamp }`, CDC: `{ replayId }`, webhook: `{ ts }`).
 * The postgres backend stores this as `sync_subscriptions.cursor` jsonb.
 */
export interface ICursorStore {
  /** Return the last persisted cursor for `subscriptionId`, or `null`. */
  get(subscriptionId: string): Promise<unknown | null>;

  /** Persist `cursor` for `subscriptionId`. Overwrites. */
  put(subscriptionId: string, cursor: unknown): Promise<void>;
}
