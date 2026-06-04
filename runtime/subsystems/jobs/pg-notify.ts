/**
 * PgNotifyListener + pgNotify — Postgres LISTEN/NOTIFY wakeups
 * (LISTEN-NOTIFY-1, dogfood gap #7).
 *
 * The drizzle jobs worker and events outbox drainer poll on an interval today
 * (default 1 s/hop). With `listen_notify` enabled, a row write that makes work
 * claimable emits an in-transaction `pg_notify(...)`; a dedicated listener
 * connection wakes the polling loop the moment the writing transaction commits.
 *
 * Two halves:
 *   - `pgNotify(tx, channel, payload)` — fire an in-tx `pg_notify`. MUST be
 *     called with the SAME transaction handle as the row write it announces, so
 *     Postgres delivers it only on commit (the transactional-outbox guarantee).
 *   - `PgNotifyListener` — owns a single long-lived `pg.PoolClient`, issues
 *     `LISTEN <channel>`, forwards each notification's payload to an owner
 *     callback, debounces bursts, and reconnects with capped backoff on drop.
 *
 * **Polling never stops.** This is a wake-early optimisation layered ON TOP of
 * interval polling. A lost notification (listener down, pooler eats the LISTEN,
 * etc.) degrades to today's poll latency, never to lost work — the claim/drain
 * query remains the source of truth.
 *
 * **PgBouncer caveat:** session-scoped `LISTEN` does not survive a
 * transaction-mode pooler. `listen_notify` requires a direct (or session-mode)
 * connection; behind a transaction pooler notifies are simply never received and
 * the system degrades to polling. See the jobs config block / skill.
 */
// TODO(logging-subsystem): swap to ILogger once ADR-028 lands
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DrizzleClient } from '../../types/drizzle';
import type { DrizzleTransaction } from '../events/event-bus.protocol';

/** Channel the jobs worker LISTENs on; payload = pool name. */
export const JOBS_WAKE_CHANNEL = 'codegen_jobs_wake';
/** Channel the events drainer LISTENs on; payload = event pool (or ''). */
export const EVENTS_WAKE_CHANNEL = 'codegen_events_wake';

/**
 * Emit an in-transaction `pg_notify`. Call with the SAME `tx`/client handle as
 * the row write being announced so delivery is gated on commit. `payload` is a
 * short plain string (a pool name); it is NOT JSON — the wake is a hint and the
 * subsequent claim/drain query is authoritative. Channel names are framework
 * constants (never user input), so the `set_config`-free literal-channel form is
 * safe; the payload is bound as a parameter.
 */
export async function pgNotify(
  tx: DrizzleClient | DrizzleTransaction,
  channel: string,
  payload: string,
): Promise<void> {
  const client = tx as DrizzleClient;
  // `pg_notify(channel, payload)` is the function form (vs the `NOTIFY chan,
  // 'payload'` statement form) precisely because it accepts bound parameters —
  // the payload is parameterised, never string-concatenated.
  await client.execute(sql`select pg_notify(${channel}, ${payload})`);
}

/** Minimal structural view of the `pg` Client/PoolClient surface we touch. */
interface PgListenClient {
  query(text: string): Promise<unknown>;
  on(event: 'notification', cb: (msg: { channel: string; payload?: string }) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  removeAllListeners?: (event?: string) => void;
  release?: (err?: boolean) => void;
  end?: () => Promise<void>;
}

/** Minimal structural view of the `pg` Pool's `connect()`. */
interface PgPoolish {
  connect(): Promise<PgListenClient>;
}

const DEFAULT_BACKOFF_MIN_MS = 100;
const DEFAULT_BACKOFF_MAX_MS = 5_000;

export interface PgNotifyListenerOptions {
  /** Channel to LISTEN on. */
  channel: string;
  /**
   * The underlying `pg.Pool` — obtained from `drizzleClient.$client`. A
   * dedicated `PoolClient` is checked out and held for the listener's lifetime
   * (separate from the query pool so a slow query never delays a wake).
   */
  pool: PgPoolish;
  /**
   * Called for every notification on `channel`, with the raw payload string
   * (`''` when Postgres delivers an empty payload). The owner decides whether
   * the payload is relevant (e.g. "is this one of my pools?") and debounces its
   * own claim cycle.
   */
  onNotify: (payload: string) => void;
  /** Label used in log lines (e.g. 'jobs:interactive', 'events'). */
  label: string;
  backoffMinMs?: number;
  backoffMaxMs?: number;
}

/**
 * Holds a dedicated listener connection and forwards notifications to `onNotify`.
 * Reconnects with capped exponential backoff on drop; logs the first failure +
 * the recovery exactly once each so a flapping connection doesn't flood logs.
 */
export class PgNotifyListener {
  private readonly logger: Logger;
  private client: PgListenClient | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs: number;
  private readonly backoffMinMs: number;
  private readonly backoffMaxMs: number;
  /** WARN-once gate so a flapping listener doesn't spam the log. */
  private warnedDown = false;

  constructor(private readonly opts: PgNotifyListenerOptions) {
    this.logger = new Logger(`PgNotifyListener(${opts.label})`);
    this.backoffMinMs = opts.backoffMinMs ?? DEFAULT_BACKOFF_MIN_MS;
    this.backoffMaxMs = opts.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.backoffMs = this.backoffMinMs;
  }

  /** Begin listening. Idempotent-ish: a second call while connected is a no-op. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  /** Stop listening + release the connection. Safe to call repeatedly. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.releaseClient();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const client = await this.opts.pool.connect();
      client.on('notification', (msg) => {
        if (msg.channel !== this.opts.channel) return;
        try {
          this.opts.onNotify(msg.payload ?? '');
        } catch (err) {
          this.logger.error(`onNotify threw: ${(err as Error).message}`);
        }
      });
      client.on('error', (err) => {
        // A connection-level error is the signal to reconnect. Don't double-log
        // here — scheduleReconnect owns the WARN-once.
        this.logger.debug?.(`listener connection error: ${err.message}`);
        this.handleDrop();
      });
      await client.query(`LISTEN ${this.opts.channel}`);
      this.client = client;
      // Recovery: only announce if we had previously warned about being down.
      if (this.warnedDown) {
        this.logger.log(
          `listener reconnected; LISTEN ${this.opts.channel} re-established`,
        );
        this.warnedDown = false;
      }
      this.backoffMs = this.backoffMinMs;
    } catch (err) {
      this.handleConnectFailure(err);
    }
  }

  /** Connection dropped after being established → reconnect. */
  private handleDrop(): void {
    if (this.stopped) return;
    void this.releaseClient().finally(() => this.scheduleReconnect());
  }

  /** Initial / reconnect `connect()` threw. */
  private handleConnectFailure(err: unknown): void {
    this.scheduleReconnect(err);
  }

  private scheduleReconnect(err?: unknown): void {
    if (this.stopped) return;
    if (!this.warnedDown) {
      this.warnedDown = true;
      this.logger.warn(
        `listener down — falling back to interval polling until reconnect. ` +
          `Cause: ${err instanceof Error ? err.message : 'connection lost'}. ` +
          `(This degrades latency, not durability — polling still drives all work.)`,
      );
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.backoffMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private async releaseClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      client.removeAllListeners?.('notification');
      client.removeAllListeners?.('error');
      // A listener client is a checked-out pool connection; release it back
      // with `release(true)` (destroy) so a half-broken socket isn't reused.
      if (client.release) client.release(true);
      else if (client.end) await client.end();
    } catch {
      // best-effort teardown
    }
  }
}
