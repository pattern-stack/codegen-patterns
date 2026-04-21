/**
 * In-memory OAuth state store.
 *
 * Single-process dev store. Production deployments need a Redis-backed impl
 * (follow-up) so state survives restarts + is shared across workers.
 */
import type {
  IOAuthStateStore,
  OAuthStateEntry,
} from '../../protocols/oauth-state-store';

export interface InMemoryOAuthStateStoreOptions {
  /** TTL in ms. Entries older than this are treated as absent. Default 10min. */
  ttlMs?: number;
  now?: () => number;
}

export class InMemoryOAuthStateStore implements IOAuthStateStore {
  private readonly store = new Map<
    string,
    { entry: OAuthStateEntry; expiresAt: number }
  >();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: InMemoryOAuthStateStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
    this.now = opts.now ?? (() => Date.now());
  }

  async put(state: string, entry: OAuthStateEntry): Promise<void> {
    this.store.set(state, { entry, expiresAt: this.now() + this.ttlMs });
  }

  async consume(state: string): Promise<OAuthStateEntry | null> {
    const slot = this.store.get(state);
    if (!slot) return null;
    this.store.delete(state);
    if (slot.expiresAt <= this.now()) return null;
    return slot.entry;
  }
}
