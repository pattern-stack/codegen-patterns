/**
 * Events subsystem — public API
 *
 * Import the module in AppModule, inject the bus via EVENT_BUS token.
 */
export type {
  DomainEvent,
  IEventBus,
  DrizzleTransaction,
  ScheduledEventSpec,
} from './event-bus.protocol';
// Augmentable event registry (ADR-037, package-mode trigger typing). A
// package-mode consumer's generated events code augments `DomainEventRegistry`
// via `declare module '@pattern-stack/codegen/runtime/subsystems/events/index'`
// so the bridge + job-trigger types pick up THEIR events with full payload
// typing. `EventTypeName` / `EventOfType` are re-exported here (the public
// barrel is the stable augmentation target); they derive from the registry, NOT
// the bundled fixture union the generated `./generated/types` re-export carries.
export type {
  DomainEventRegistry,
  EventTypeName,
  EventOfType,
} from './event-registry';
export type {
  IEventReadPort,
  ListEventsQuery,
  EventSummary,
  EventPage,
} from './event-read.protocol';
export {
  EVENT_BUS,
  EVENT_READ_PORT,
  EVENTS_MODULE_OPTIONS,
  EVENTS_MULTI_TENANT,
  TYPED_EVENT_BUS,
} from './events.tokens';
export { TypedEventBus } from './generated/bus';
export { MissingTenantIdError, ScheduleConfigError } from './events-errors';
export { EventsModule, EventSchedulerLifecycle } from './events.module';
export type { EventsModuleOptions } from './events.module';
// ADR-039 — declarative time-based scheduling (time as an event source).
export {
  EventScheduler,
  parseEvery,
  slotStartFor,
  nextSlotStart,
  slotKeyFor,
  resolveScheduledEvent,
  scheduledEventsFromRegistry,
  SCHEDULE_KEY_PREFIX,
  SCHEDULE_FLOOR_MS,
} from './event-scheduler';
export type {
  ScheduledEvent,
  RegistrySchedule,
  EventSchedulerOptions,
} from './event-scheduler';
export { MemoryEventBus } from './event-bus.memory-backend';
export { DrizzleEventBus } from './event-bus.drizzle-backend';
// #6 — the BullMQ scheduler driver (`event-scheduler.bullmq-backend.ts`,
// ADR-041 option #2) is NOT re-exported here. It is only vendored when
// `events.scheduler.driver: bullmq`; surfacing it from this barrel would force
// a poll-driver consumer's tsc to resolve it (+ the optional `bullmq` peer dep)
// even though the file is filtered out → TS2307. `EventsModule.forRoot` lazy-
// loads it internally via `loadBullMqScheduler` (non-literal dynamic import).
export { domainEvents } from './domain-events.schema';
export type { DomainEventRecord } from './domain-events.schema';
