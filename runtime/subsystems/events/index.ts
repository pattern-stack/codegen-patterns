/**
 * Events subsystem — public API
 *
 * Import the module in AppModule, inject the bus via EVENT_BUS token.
 */
export type { DomainEvent, IEventBus, DrizzleTransaction } from './event-bus.protocol';
export { EVENT_BUS, EVENTS_MODULE_OPTIONS } from './events.tokens';
export { EventsModule } from './events.module';
export type { EventsModuleOptions } from './events.module';
export { MemoryEventBus } from './event-bus.memory-backend';
export { DrizzleEventBus } from './event-bus.drizzle-backend';
export { RedisEventBus } from './event-bus.redis-backend';
export { domainEvents } from './domain-events.schema';
export type { DomainEventRecord } from './domain-events.schema';
