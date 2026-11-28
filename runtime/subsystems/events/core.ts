/**
 * Events subsystem — the Nest-free entry (PW-0).
 *
 * Everything in the events public API that loads no `@nestjs/*` package, type
 * imports included: the protocols, the augmentable registry, the tokens, the
 * errors, the scheduler and the outbox schema. A pattern-stack app (`target.wiring:
 * pattern-stack`) imports through this file (`subsystemCoreImport(mode, 'events')`);
 * `./index` re-exports it beside the Nest module and the decorated backends.
 * `src/__tests__/runtime/nest-free.test.ts` holds it Nest-free.
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
export { MissingTenantIdError, ScheduleConfigError } from './events-errors';
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
export { domainEvents } from './domain-events.schema';
// The options the backends and the pattern-stack `events` system take (S-1).
export type { EventsModuleOptions } from './events-options';
export type { DomainEventRecord } from './domain-events.schema';
