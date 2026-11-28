/**
 * Events subsystem — public API
 *
 * Import the module in AppModule, inject the bus via EVENT_BUS token.
 */
// The Nest-free half of the API (PW-0): protocols, registry, tokens, errors,
// scheduler, outbox schema.
export * from './core';
export { TypedEventBus } from './generated/bus';
export { EventsModule, EventSchedulerLifecycle } from './events.module';
export { MemoryEventBus } from './event-bus.memory-backend';
export { DrizzleEventBus } from './event-bus.drizzle-backend';
// #6 — backend-specific implementation classes are NOT re-exported here.
// `RedisEventBus` is only vendored when the consumer installs with
// `--backend redis`; surfacing it from this barrel would force the consumer's
// tsc to resolve `./event-bus.redis-backend` even on a drizzle/memory install
// (the file is filtered out → TS2307). Consumers who select redis import the
// class directly from `./event-bus.redis-backend` if they need it at all —
// `EventsModule.forRoot({ backend: 'redis' })` lazy-loads it internally.
