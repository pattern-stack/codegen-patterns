/**
 * RedisEventBus — Redis Pub/Sub backend for the event bus.
 *
 * Publishes events to Redis channels and dispatches incoming messages to
 * registered in-process subscribers. Events are serialized as JSON strings.
 *
 * Channel naming:
 *   - Per-type channel:  events:{event.type}   (e.g. events:contact_created)
 *   - Catch-all channel: events:*
 *
 * Transactional semantics:
 *   The `tx` parameter (Drizzle transaction) is accepted to satisfy the
 *   IEventBus interface but has no effect — Redis Pub/Sub is not transactional.
 *   Events published with a `tx` argument are dispatched immediately without
 *   waiting for the surrounding transaction to commit. If you need
 *   at-least-once delivery tied to a database transaction, use DrizzleEventBus.
 *
 * Connection model:
 *   ioredis requires a dedicated connection for subscribers (a client in
 *   subscribe mode cannot issue regular commands). This backend creates two
 *   clients: one for publishing (`publisher`) and one for subscribing
 *   (`subscriber`). Both are connected on module init and disconnected on
 *   module destroy.
 *
 * Usage:
 *   EventsModule.forRoot({ backend: 'redis', redisUrl: 'redis://localhost:6379' })
 *
 * Requires `ioredis` — install it separately if you use this backend:
 *   npm install ioredis   /   bun add ioredis
 */
import { Injectable, OnModuleInit, OnModuleDestroy, Inject, Logger } from '@nestjs/common';
import type { DomainEvent, DrizzleTransaction, IEventBus } from './event-bus.protocol';
import { REDIS_URL } from './events.tokens';

/** Redis channel prefix for all domain events. */
const CHANNEL_PREFIX = 'events:';
/** Catch-all channel that receives every published event. */
const WILDCARD_CHANNEL = 'events:*';

// ioredis is an optional peer dependency; import lazily so consumers who do
// not use this backend do not need it on their classpath.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisClient = any;

async function createRedisClient(url: string): Promise<RedisClient> {
  let Redis: { new (url: string): RedisClient };
  try {
    const mod = await import('ioredis');
    Redis = mod.default ?? mod;
  } catch {
    throw new Error(
      'RedisEventBus requires the "ioredis" package. Install it with: npm install ioredis',
    );
  }
  return new Redis(url);
}

@Injectable()
export class RedisEventBus implements IEventBus, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisEventBus.name);

  private publisher: RedisClient | null = null;
  private subscriber: RedisClient | null = null;
  private connected = false;

  /**
   * In-process subscriber registry. Handlers registered here are called when
   * a message arrives on the subscriber client — keeping fan-out within the
   * same process without an extra round-trip through Redis.
   */
  private readonly handlers = new Map<string, Set<(event: DomainEvent) => Promise<void>>>();

  /**
   * Track which event types have active Redis subscriptions.
   * Used to avoid subscribing multiple times to the same type channel.
   */
  private readonly subscribedTypes = new Set<string>();

  constructor(@Inject(REDIS_URL) private readonly redisUrl: string) {}

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async onModuleInit(): Promise<void> {
    this.publisher = await createRedisClient(this.redisUrl);
    this.subscriber = await createRedisClient(this.redisUrl);

    // Surface connection errors without crashing the process.
    this.publisher.on('error', (err: Error) =>
      this.logger.error(`Redis publisher error: ${err.message}`, err.stack),
    );
    this.subscriber.on('error', (err: Error) =>
      this.logger.error(`Redis subscriber error: ${err.message}`, err.stack),
    );

    // Set up message listener for per-type subscriptions.
    // Subscriptions are created lazily when the first handler is registered for a type.
    this.subscriber.on('message', (channel: string, message: string) => {
      void this.handleMessage(channel, message);
    });

    this.connected = true;
    this.logger.log(`RedisEventBus connected to ${this.redisUrl}`);
  }

  async onModuleDestroy(): Promise<void> {
    this.connected = false;

    if (this.subscriber) {
      // Unsubscribe from all channels and disconnect the subscriber.
      // unsubscribe() with no args unsubscribes from all channels.
      await this.subscriber.unsubscribe();
      this.subscriber.disconnect();
      this.subscriber = null;
    }

    if (this.publisher) {
      this.publisher.disconnect();
      this.publisher = null;
    }

    this.subscribedTypes.clear();
    this.logger.log('RedisEventBus disconnected');
  }

  // ============================================================================
  // IEventBus
  // ============================================================================

  /**
   * Publish a single event.
   *
   * `tx` is accepted but ignored — see module-level JSDoc for details.
   */
  async publish(event: DomainEvent, tx?: DrizzleTransaction): Promise<void> {
    void tx; // intentionally unused — Redis Pub/Sub is not transactional
    this.assertConnected();

    const payload = this.serialize(event);
    const channel = `${CHANNEL_PREFIX}${event.type}`;

    await this.publisher!.publish(channel, payload);
  }

  /**
   * Publish multiple events using a pipeline so all PUBLISH commands are sent
   * in a single round-trip.
   *
   * `tx` is accepted but ignored — see module-level JSDoc for details.
   */
  async publishMany(events: DomainEvent[], tx?: DrizzleTransaction): Promise<void> {
    void tx; // intentionally unused — Redis Pub/Sub is not transactional
    if (events.length === 0) return;
    this.assertConnected();

    const pipeline = this.publisher!.pipeline();
    for (const event of events) {
      const payload = this.serialize(event);
      const channel = `${CHANNEL_PREFIX}${event.type}`;
      pipeline.publish(channel, payload);
    }
    await pipeline.exec();
  }

  /**
   * Register a handler for a specific event type.
   * Returns an unsubscribe function — call it to remove the handler.
   *
   * On first handler for a type, subscribes to the per-type Redis channel.
   * On removal of the last handler for a type, unsubscribes from the channel.
   */
  subscribe<T extends DomainEvent = DomainEvent>(
    eventType: string,
    handler: (event: T) => Promise<void>,
  ): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
      // First handler for this type — subscribe to the per-type channel in Redis.
      void this.subscribeToType(eventType);
    }
    const set = this.handlers.get(eventType)!;
    const h = handler as (event: DomainEvent) => Promise<void>;
    set.add(h);

    return () => {
      set.delete(h);
      // If no more handlers for this type, unsubscribe from the Redis channel.
      if (set.size === 0) {
        this.handlers.delete(eventType);
        void this.unsubscribeFromType(eventType);
      }
    };
  }

  // ============================================================================
  // Internal helpers
  // ============================================================================

  private assertConnected(): void {
    if (!this.connected || !this.publisher) {
      throw new Error(
        'RedisEventBus is not connected. Ensure the module has been initialised before publishing.',
      );
    }
  }

  private serialize(event: DomainEvent): string {
    return JSON.stringify({
      ...event,
      occurredAt: event.occurredAt.toISOString(),
    });
  }

  private deserialize(raw: string): DomainEvent {
    const parsed = JSON.parse(raw) as DomainEvent & { occurredAt: string };
    return {
      ...parsed,
      occurredAt: new Date(parsed.occurredAt),
    };
  }

  private async handleMessage(channel: string, message: string): Promise<void> {
    let event: DomainEvent;
    try {
      event = this.deserialize(message);
    } catch (err) {
      this.logger.warn(`Failed to deserialize event on channel "${channel}": ${err}`);
      return;
    }

    await this.dispatch(event);
  }

  private async dispatch(event: DomainEvent): Promise<void> {
    const set = this.handlers.get(event.type);
    if (!set) return;
    for (const handler of set) {
      try {
        await handler(event);
      } catch (err) {
        this.logger.error(
          `Handler error for event type "${event.type}" (id: ${event.id}): ${err}`,
        );
      }
    }
  }

  /**
   * Subscribe to a per-type Redis channel.
   * Called lazily when the first handler is registered for a type.
   */
  private async subscribeToType(eventType: string): Promise<void> {
    if (this.subscribedTypes.has(eventType)) {
      return; // Already subscribed to this type.
    }

    const channel = `${CHANNEL_PREFIX}${eventType}`;
    try {
      await this.subscriber!.subscribe(channel);
      this.subscribedTypes.add(eventType);
    } catch (err) {
      this.logger.error(`Failed to subscribe to channel "${channel}": ${err}`);
    }
  }

  /**
   * Unsubscribe from a per-type Redis channel.
   * Called when the last handler for a type is removed.
   */
  private async unsubscribeFromType(eventType: string): Promise<void> {
    if (!this.subscribedTypes.has(eventType)) {
      return; // Not subscribed to this type.
    }

    const channel = `${CHANNEL_PREFIX}${eventType}`;
    try {
      await this.subscriber!.unsubscribe(channel);
      this.subscribedTypes.delete(eventType);
    } catch (err) {
      this.logger.error(`Failed to unsubscribe from channel "${channel}": ${err}`);
    }
  }
}
