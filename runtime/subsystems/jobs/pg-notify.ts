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
  /**
   * LISTEN-NOTIFY-2 — the in-flight `connect()` promise, set while a checkout is
   * mid-`await`. `stop()` awaits it so a `stop()` that races a still-resolving
   * `connect()` can't return before the connect either assigns `this.client`
   * (then released by `releaseClient`) or self-releases the checked-out client.
   * Without this, a `stop()` arriving during `pool.connect()`'s await saw
   * `this.client === null` (nothing to release), then `connect()` resumed,
   * assigned the client, and issued `LISTEN` — leaking an ESTABLISHED socket
   * holding `LISTEN <channel>` forever past `app.close()`.
   */
  private connecting: Promise<void> | null = null;

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

  /**
   * Stop listening + release the connection. Safe to call repeatedly and
   * race-safe against an in-flight `connect()` (LISTEN-NOTIFY-2): it sets
   * `stopped` first (so a resuming `connect()` self-releases its checkout),
   * then awaits any in-flight connect, then releases whatever client landed.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Await an in-flight checkout so we don't return while a client is still
    // mid-`pool.connect()`. The resuming `connect()` sees `stopped` and either
    // self-releases its checkout or assigns `this.client`; either way the
    // `releaseClient()` below mops up.
    const inflight = this.connecting;
    if (inflight) {
      try {
        await inflight;
      } catch {
        // connect failures are handled inside connect(); ignore here.
      }
    }
    await this.releaseClient();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    // Track this checkout so a racing stop() can await it (LISTEN-NOTIFY-2).
    const attempt = this.doConnect();
    this.connecting = attempt;
    try {
      await attempt;
    } finally {
      if (this.connecting === attempt) this.connecting = null;
    }
  }

  private async doConnect(): Promise<void> {
    try {
      const client = await this.opts.pool.connect();
      // Re-check AFTER the await resolves: a stop() may have fired while this
      // checkout was in flight. If so, release the just-checked-out client
      // right here and bail BEFORE wiring handlers / issuing LISTEN — otherwise
      // we'd leak an ESTABLISHED listener socket past shutdown (LISTEN-NOTIFY-2).
      if (this.stopped) {
        await this.releaseRawClient(client);
        return;
      }
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
      // A stop() could have fired during the LISTEN round-trip too — same guard.
      if (this.stopped) {
        await this.releaseRawClient(client);
        return;
      }
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
    await this.releaseRawClient(client);
  }

  /**
   * Tear down a raw checked-out client (LISTEN-NOTIFY-2). Used both by the
   * normal `releaseClient()` path and by the connect-vs-stop race bail-outs,
   * where the client was checked out but never assigned to `this.client`.
   * Destroys (`release(true)`) so a half-listening socket is never reused.
   */
  private async releaseRawClient(client: PgListenClient): Promise<void> {
    try {
      client.removeAllListeners?.('notification');
      client.removeAllListeners?.('error');
      if (client.release) client.release(true);
      else if (client.end) await client.end();
    } catch {
      // best-effort teardown
    }
  }
}
