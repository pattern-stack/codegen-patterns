/**
 * EventScheduler — declarative time-based emission (ADR-039: time as an event
 * source). Materialises exactly one `domain_events` row per (scheduled event
 * type, slot) on a cadence; ADR-023's three activation tiers — unchanged — then
 * react. The scheduler is a STRICT PRODUCER: it emits facts and does no work
 * (the dealbrain `scheduler.service.ts` shape, generalised onto the outbox).
 *
 * Two entry points, both driven by `EventsModule`'s lifecycle:
 *
 *   - **reconcile-on-boot** (`materializeBoot`, at `onModuleInit`) — for every
 *     scheduled event type, materialise the CURRENT slot (catch-up off → run
 *     once on recovery) or bounded backfill (catch-up on). Boot is when a
 *     downtime-healing tick matters most. In the outbox model a removed
 *     `schedule:` simply stops being materialised — there's no broker scheduler
 *     entry to leave dangling, so the dealbrain ENG-605 "zombie scheduler" class
 *     of bug is structurally absent; the reconcile half is what we keep.
 *   - **tick pass** (`materializeTick` on an interval) — materialise each
 *     scheduled event's NEXT (and current) slot so ticks self-perpetuate.
 *
 * Exactly-one-per-slot lives in the DB (the partial UNIQUE expression index on
 * `(type, metadata->>'scheduleSlot')`), reached via
 * `IEventBus.materializeScheduledEvent` → `INSERT … ON CONFLICT DO NOTHING`.
 * The scheduler never READS for an existing slot event (that read is the
 * swe-brain dedupe trap — it matches the still-running incumbent). The slot key
 * is a pure function of (type, slot), so every instance computes the same key
 * and the constraint collapses the race.
 *
 * Drizzle + memory only. The Redis bus retains no outbox history, so slot-key
 * idempotency can't be enforced there (mirrors bridge-on-Redis being
 * unsupported); the scheduler is not wired under `backend: 'redis'`.
 */
import { Logger } from '@nestjs/common';
import type { IEventBus } from './event-bus.protocol';
import { ScheduleConfigError } from './events-errors';

// ─── Duration grammar ────────────────────────────────────────────────────────

const UNIT_MS: Readonly<Record<string, number>> = Object.freeze({
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
});

/**
 * Parse a `schedule.every` into milliseconds. Accepts a positive number (ms) or
 * a duration string `<number><unit>` (unit ∈ ms|s|m|h|d; decimals allowed).
 * Throws `ScheduleConfigError` synchronously on anything unparseable, ≤0, or
 * non-finite — so a bad schedule surfaces at boot before the tick loop starts.
 */
export function parseEvery(every: string | number, eventType?: string): number {
  const where = eventType ? ` (event '${eventType}')` : '';
  let ms: number;
  if (typeof every === 'number') {
    ms = every;
  } else if (typeof every === 'string') {
    const match = /^\s*([0-9]*\.?[0-9]+)\s*(ms|s|m|h|d)\s*$/.exec(every);
    if (!match) {
      throw new ScheduleConfigError(
        `schedule.every '${every}'${where} is not a valid duration. Use a ` +
          `number of ms or '<n><unit>' with unit ms|s|m|h|d (e.g. '1h', '30m').`,
      );
    }
    ms = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  } else {
    throw new ScheduleConfigError(
      `schedule.every${where} must be a duration string or a number of ms; ` +
        `got ${typeof every}.`,
    );
  }
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new ScheduleConfigError(
      `schedule.every${where} resolved to ${ms}ms — must be a finite, positive ` +
        `duration.`,
    );
  }
  return ms;
}

// ─── Slot math ───────────────────────────────────────────────────────────────

/**
 * The start of the slot containing `atMs`, for a schedule of `everyMs`.
 *   - `align: true` (default) — epoch-anchored: `floor(at / every) * every`.
 *   - `align: false` — anchored to `anchorMs` (the scheduler's first-run time).
 */
export function slotStartFor(
  atMs: number,
  everyMs: number,
  align: boolean,
  anchorMs: number,
): number {
  if (align) return Math.floor(atMs / everyMs) * everyMs;
  if (atMs < anchorMs) return anchorMs;
  return anchorMs + Math.floor((atMs - anchorMs) / everyMs) * everyMs;
}

/** The start of the slot AFTER the one containing `atMs`. */
export function nextSlotStart(
  atMs: number,
  everyMs: number,
  align: boolean,
  anchorMs: number,
): number {
  return slotStartFor(atMs, everyMs, align, anchorMs) + everyMs;
}

/** Prefix every scheduler-materialised `metadata.scheduleSlot` carries — the
 *  partial UNIQUE index is scoped to non-null slot keys; this prefix keeps the
 *  key namespace unambiguous and greppable. */
export const SCHEDULE_KEY_PREFIX = '@schedule/';

/** Deterministic slot key. Pure function of (type, slotStart) — every instance
 *  computes the same value, which is what makes the idempotent insert
 *  exactly-once. */
export function slotKeyFor(type: string, slotStartMs: number): string {
  return `${SCHEDULE_KEY_PREFIX}${type}/${slotStartMs}`;
}

// ─── Resolved schedule ───────────────────────────────────────────────────────

const DEFAULT_MAX_CATCH_UP_SLOTS = 1000;

/** Below this floor (== the default outbox poll interval) materialise/drain
 *  latency dominates the cadence; allowed but warned once at boot. */
export const SCHEDULE_FLOOR_MS = 1_000;

/** One scheduled event the scheduler will materialise. Built from the generated
 *  event registry (`schedule` block + direction/pool routing metadata). */
export interface ScheduledEvent {
  type: string;
  everyMs: number;
  align: boolean;
  catchUp: boolean;
  maxCatchUpSlots: number;
  /** Routing — from the event's registry metadata (a scheduled event is
   *  domain-tier, so both are always present). */
  direction: string;
  pool: string;
}

/** The raw `schedule` block as it appears in the generated registry entry. */
export interface RegistrySchedule {
  every: string | number;
  align?: boolean;
  catchUp?: boolean;
  maxCatchUpSlots?: number;
}

/** Validate + normalise one registry entry's `schedule` into a `ScheduledEvent`.
 *  Throws `ScheduleConfigError` on a malformed `every` (boot backstop — codegen
 *  already validated, this catches hand-edits / version skew). */
export function resolveScheduledEvent(
  type: string,
  schedule: RegistrySchedule,
  direction: string | null,
  pool: string | null,
): ScheduledEvent {
  if (!direction || !pool) {
    throw new ScheduleConfigError(
      `event '${type}' declares a schedule but has no direction/pool — a ` +
        `scheduled event must be domain-tier so it can route to the bridge.`,
    );
  }
  return {
    type,
    everyMs: parseEvery(schedule.every, type),
    align: schedule.align ?? true,
    catchUp: schedule.catchUp ?? false,
    maxCatchUpSlots: schedule.maxCatchUpSlots ?? DEFAULT_MAX_CATCH_UP_SLOTS,
    direction,
    pool,
  };
}

/**
 * Read the scheduled-event set from a generated `eventRegistry`. The registry
 * value shape is structural (`{ schedule?, direction, pool }`) so this stays
 * decoupled from the generated `EventMetadata` type. Returns `[]` when nothing
 * declared `schedule:`.
 */
export function scheduledEventsFromRegistry(
  registry: Record<
    string,
    { schedule?: RegistrySchedule; direction: string | null; pool: string | null }
  >,
): ScheduledEvent[] {
  const out: ScheduledEvent[] = [];
  for (const [type, meta] of Object.entries(registry)) {
    if (!meta?.schedule) continue;
    out.push(resolveScheduledEvent(type, meta.schedule, meta.direction, meta.pool));
  }
  return out;
}

// ─── EventScheduler ──────────────────────────────────────────────────────────

export interface EventSchedulerOptions {
  /** Tick cadence (ms). Default = smallest scheduled `every`, floored. Test override. */
  tickIntervalMs?: number;
  /** Injectable clock for deterministic tests. Default `Date.now`. */
  now?: () => number;
}

export class EventScheduler {
  private readonly logger = new Logger(EventScheduler.name);
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly anchorMs: number;
  private readonly tickIntervalMs: number;

  constructor(
    private readonly bus: IEventBus,
    private readonly schedules: ReadonlyArray<ScheduledEvent>,
    opts: EventSchedulerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.anchorMs = this.now();
    const smallest = schedules.length
      ? Math.min(...schedules.map((s) => s.everyMs))
      : SCHEDULE_FLOOR_MS;
    this.tickIntervalMs = opts.tickIntervalMs ?? Math.max(smallest, SCHEDULE_FLOOR_MS);
    for (const s of schedules) {
      if (s.everyMs < SCHEDULE_FLOOR_MS) {
        this.logger.warn(
          `schedule for '${s.type}' is every ${s.everyMs}ms — below the ` +
            `${SCHEDULE_FLOOR_MS}ms floor; materialise/drain latency dominates, ` +
            `so the cadence is not honoured to that precision.`,
        );
      }
    }
    if (typeof bus.materializeScheduledEvent !== 'function') {
      // The backend (e.g. Redis) cannot enforce slot idempotency. Caller
      // should not construct the scheduler for such backends; guard anyway.
      this.logger.warn(
        `the configured event bus does not support scheduled-event ` +
          `materialisation; ${schedules.length} schedule(s) will not fire.`,
      );
    }
  }

  /** Reconcile-on-boot, then start the tick interval. Idempotent. */
  async start(): Promise<void> {
    if (this.schedules.length === 0) return;
    if (typeof this.bus.materializeScheduledEvent !== 'function') return;
    await this.materializeBoot();
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.materializeTick();
    }, this.tickIntervalMs);
    (this.timer as { unref?: () => void }).unref?.();
    this.logger.log(
      `EventScheduler started: ${this.schedules.length} scheduled event(s), ` +
        `tick=${this.tickIntervalMs}ms.`,
    );
  }

  /** Stop the tick interval. Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Boot pass — materialise the current slot (or bounded backfill) per event. */
  async materializeBoot(): Promise<void> {
    const nowMs = this.now();
    for (const s of this.schedules) {
      try {
        if (s.catchUp) {
          await this.backfill(s, nowMs);
        } else {
          await this.materializeOne(s, slotStartFor(nowMs, s.everyMs, s.align, this.anchorMs));
        }
      } catch (err) {
        this.logger.error(
          `boot materialise for '${s.type}' failed: ${(err as Error).message}`,
        );
      }
    }
  }

  /** Tick pass — materialise the current + next slot per event (current covers a
   *  tick landing in a fresh slot the boot pass missed). */
  async materializeTick(): Promise<void> {
    const nowMs = this.now();
    for (const s of this.schedules) {
      try {
        const current = slotStartFor(nowMs, s.everyMs, s.align, this.anchorMs);
        await this.materializeOne(s, current);
        await this.materializeOne(s, current + s.everyMs);
      } catch (err) {
        this.logger.error(
          `tick materialise for '${s.type}' failed: ${(err as Error).message}`,
        );
      }
    }
  }

  private async materializeOne(s: ScheduledEvent, slotStartMs: number): Promise<void> {
    const slotKey = slotKeyFor(s.type, slotStartMs);
    const { created } = await this.bus.materializeScheduledEvent!({
      type: s.type,
      slotKey,
      slotStart: new Date(slotStartMs),
      direction: s.direction,
      pool: s.pool,
    });
    if (created) {
      this.logger.debug?.(
        `materialised '${s.type}' slot ${new Date(slotStartMs).toISOString()}`,
      );
    }
  }

  /** Backfill missed slots from the last emitted slot to the current one,
   *  bounded by `maxCatchUpSlots`. */
  private async backfill(s: ScheduledEvent, nowMs: number): Promise<void> {
    const current = slotStartFor(nowMs, s.everyMs, s.align, this.anchorMs);
    const lastMs = (await this.bus.lastScheduledSlotMs?.(s.type)) ?? null;
    let from = lastMs !== null ? lastMs + s.everyMs : current;
    if (from > current) from = current; // last >= current → just (re)try current
    const total = Math.floor((current - from) / s.everyMs) + 1;
    if (total > s.maxCatchUpSlots) {
      const dropped = total - s.maxCatchUpSlots;
      from = current - (s.maxCatchUpSlots - 1) * s.everyMs;
      this.logger.warn(
        `catchUp for '${s.type}' would backfill ${total} slots; capping at ` +
          `${s.maxCatchUpSlots} (dropping ${dropped} oldest).`,
      );
    }
    for (let slot = from; slot <= current; slot += s.everyMs) {
      await this.materializeOne(s, slot);
    }
  }
}
