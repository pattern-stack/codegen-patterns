/**
 * MemoryEventBus — in-memory backend for the event bus.
 *
 * Dispatches events synchronously to registered subscribers. The `tx`
 * parameter is ignored — all events are dispatched immediately.
 *
 * Use this backend in tests to assert event publication without a database.
 * Swap via EventsModule.forRoot({ backend: 'memory' }).
 */
import { Injectable } from '@nestjs/common';
import type { DomainEvent, IEventBus } from './event-bus.protocol';

@Injectable()
export class MemoryEventBus implements IEventBus {
  /** All events published since construction (or last clear). */
  readonly publishedEvents: DomainEvent[] = [];

  private readonly handlers = new Map<string, Set<(event: DomainEvent) => Promise<void>>>();

  async publish(event: DomainEvent): Promise<void> {
    this.publishedEvents.push(event);
    await this.dispatch(event);
  }

  async publishMany(events: DomainEvent[]): Promise<void> {
    for (const event of events) {
      await this.publish(event);
    }
  }

  subscribe<T extends DomainEvent = DomainEvent>(
    eventType: string,
    handler: (event: T) => Promise<void>,
  ): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    // Cast is safe — callers pass a typed handler; we store as the base type
    const set = this.handlers.get(eventType)!;
    const h = handler as (event: DomainEvent) => Promise<void>;
    set.add(h);

    return () => {
      set.delete(h);
    };
  }

  /** Remove all published events and subscriptions. Useful in beforeEach. */
  clear(): void {
    this.publishedEvents.length = 0;
    this.handlers.clear();
  }

  private async dispatch(event: DomainEvent): Promise<void> {
    const set = this.handlers.get(event.type);
    if (!set) return;
    for (const handler of set) {
      await handler(event);
    }
  }
}
