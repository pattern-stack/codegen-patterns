/**
 * Drizzle-backed `IOAuthStateStore`.
 *
 * Uses the `auth_oauth_state` table (see `auth-oauth-state.schema.ts`).
 * Single-use semantics enforced via `DELETE ... RETURNING`: the consume
 * path atomically deletes and returns the row, so a concurrent /callback
 * with the same state cannot replay.
 *
 * Behaviour:
 *   - `generate(record)` mints a 256-bit base64url token, INSERTs the row
 *     with `expires_at = now() + ttlMs`.
 *   - `consume(state)` runs `DELETE ... WHERE state = $1 RETURNING ...`
 *     once. Throws `OAuthStateError('missing')` if no row was deleted
 *     (unknown or already consumed) and `OAuthStateError('expired')` if
 *     the deleted row was past its `expires_at`.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '../../../types/drizzle';
import { authOAuthState } from '../auth-oauth-state.schema';
import {
  type IOAuthStateStore,
  type OAuthStateRecord,
  OAuthStateError,
} from '../protocols/oauth-state-store';

export interface DrizzleOAuthStateStoreOptions {
  /** TTL in ms. Default 10 minutes. */
  ttlMs?: number;
  /** Injectable clock for tests. Default `Date.now`. */
  now?: () => number;
  /** Injectable token generator for tests. Default 32-byte base64url. */
  generateToken?: () => string;
}

export class DrizzleOAuthStateStore implements IOAuthStateStore {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly generateToken: () => string;

  constructor(
    private readonly db: DrizzleClient,
    opts: DrizzleOAuthStateStoreOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
    this.now = opts.now ?? (() => Date.now());
    this.generateToken =
      opts.generateToken ?? (() => randomBytes(32).toString('base64url'));
  }

  async generate(record: OAuthStateRecord): Promise<string> {
    const state = this.generateToken();
    const expiresAt = new Date(this.now() + this.ttlMs);
    await this.db.insert(authOAuthState).values({
      state,
      userId: record.userId,
      redirect: record.redirect ?? null,
      expiresAt,
    });
    return state;
  }

  async consume(state: string): Promise<OAuthStateRecord> {
    const rows = await this.db
      .delete(authOAuthState)
      .where(eq(authOAuthState.state, state))
      .returning();
    const row = rows[0];
    if (!row) {
      throw new OAuthStateError(
        `OAuth state token unknown or already consumed`,
        'missing',
      );
    }
    if (row.expiresAt.getTime() <= this.now()) {
      throw new OAuthStateError(`OAuth state token expired`, 'expired');
    }
    return {
      userId: row.userId,
      redirect: row.redirect ?? undefined,
    };
  }
}
