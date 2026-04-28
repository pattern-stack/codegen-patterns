/**
 * In-memory `IOAuthStateStore` backend.
 *
 * Single-process store — Map<state, { record, expiresAt }>. Suitable for
 * tests and single-worker dev. Production deployments select the drizzle
 * backend so state survives restarts and is shared across workers.
 *
 * Single-use semantics:
 *   - `generate(record)` mints a 256-bit random token (base64url, opaque).
 *   - `consume(state)` deletes the entry on read. A second call with the
 *     same state throws `OAuthStateError('replay')`.
 *   - Expired entries also throw (`'expired'`); the entry is deleted as a
 *     side effect so a later replay still surfaces correctly.
 *
 * TTL defaults to 10 minutes — long enough for a user to complete the
 * provider's consent screen, short enough that abandoned states age out.
 */
import { randomBytes } from 'node:crypto';
import {
  type IOAuthStateStore,
  type OAuthStateRecord,
  OAuthStateError,
} from '../protocols/oauth-state-store';

export interface MemoryOAuthStateStoreOptions {
  /** TTL in ms. Default 10 minutes. */
  ttlMs?: number;
  /** Injectable clock for tests. Default `Date.now`. */
  now?: () => number;
  /** Injectable token generator for tests. Default 32-byte base64url. */
  generateToken?: () => string;
}

interface Slot {
  record: OAuthStateRecord;
  expiresAt: number;
}

export class MemoryOAuthStateStore implements IOAuthStateStore {
  private readonly store = new Map<string, Slot>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly generateToken: () => string;

  constructor(opts: MemoryOAuthStateStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
    this.now = opts.now ?? (() => Date.now());
    this.generateToken =
      opts.generateToken ?? (() => randomBytes(32).toString('base64url'));
  }

  async generate(record: OAuthStateRecord): Promise<string> {
    const state = this.generateToken();
    this.store.set(state, {
      record: { ...record },
      expiresAt: this.now() + this.ttlMs,
    });
    return state;
  }

  async consume(state: string): Promise<OAuthStateRecord> {
    const slot = this.store.get(state);
    if (!slot) {
      throw new OAuthStateError(
        `OAuth state token unknown or already consumed`,
        'missing',
      );
    }
    // Delete first so a concurrent consume can't replay.
    this.store.delete(state);
    if (slot.expiresAt <= this.now()) {
      throw new OAuthStateError(`OAuth state token expired`, 'expired');
    }
    return slot.record;
  }
}
