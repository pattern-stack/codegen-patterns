/**
 * Auth subsystem — `IOAuthStateStore` port.
 *
 * CSRF protection for the OAuth2 authorize-code callback. Generic across
 * providers. The store mints opaque state tokens at /connect time and
 * single-use consumes them at /callback time, returning the original
 * record (userId + optional post-callback redirect path).
 *
 * Concrete backends live under `../backends/`:
 *   - `state-store.memory-backend.ts` — in-process Map (tests/dev).
 *   - `state-store.drizzle-backend.ts` — Postgres (prod).
 *
 * Semantics:
 *   - `generate(record)` → returns an opaque state token; record is stored
 *     under that token until consumed or until TTL expires.
 *   - `consume(state)`   → atomically deletes the entry and returns the
 *     record. Throws on missing, expired, or replayed state. Never returns
 *     null — a missing/expired state is a CSRF signal.
 */
export interface OAuthStateRecord {
  userId: string;
  /** Optional post-callback redirect path (relative URL). */
  redirect?: string;
}

export interface IOAuthStateStore {
  /** Mint an opaque state token bound to `record`. Single-use. */
  generate(record: OAuthStateRecord): Promise<string>;
  /**
   * Atomically consume `state`, returning the bound record. Throws on
   * missing / expired / replayed state.
   */
  consume(state: string): Promise<OAuthStateRecord>;
}

/**
 * Thrown by `IOAuthStateStore.consume` when the state token is unknown,
 * expired, or has already been consumed (replay attempt).
 */
export class OAuthStateError extends Error {
  constructor(
    message: string,
    public readonly reason: 'missing' | 'expired',
  ) {
    super(message);
    this.name = 'OAuthStateError';
  }
}
