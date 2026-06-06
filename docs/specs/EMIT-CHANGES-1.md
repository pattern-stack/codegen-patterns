# EMIT-CHANGES-1 — Opt-in post-upsert change-event emission seam

**Status:** Implemented
**Last Updated:** 2026-06-06
**Depends on:** the events subsystem (TypedEventBus, EventDefinition desugar), the
integration subsystem (`ExecuteIntegrationUseCase`, the `IIntegrationSink`
contract), and the assembly-default-sinks stack (#485–#492 — the per-entity
assembly module + sink emission this rides alongside).
**Consumer driver:** swe-brain (dogfood) — ADR-0009 Amendment B vocabulary
(`_edited` not `_updated`; tombstone soft-deletes; typed domain-gated events).

## Overview

When integration sync upserts/soft-deletes a row, the differ records
`changed_fields` on `integration_run_items` — but no **domain event** fires.
Consumers building a trigger→action primitive need "a thing happened" events for
every inbound entity. Today they hand-build emission in each sink. This seam
generalizes that: an entity opts in with one YAML flag, and codegen wires the
orchestrator to publish a typed `<entity>_created` / `<entity>_edited` /
`<entity>_deleted` domain event after every sink write/soft-delete.

```
ExecuteIntegrationUseCase.processChange(...)
     │  sink.upsertByExternalId / softDeleteByExternalId   (existing)
     │  recorder.recordItem(... changed_fields ...)        (existing)
     ▼
  emitter?.emitChange({ entityId, externalId, provider, action, changedFields })  ← NEW (optional)
     │  (bound only for opted-in entities; unbound ⇒ no-op, back-compat)
     ▼
  <Entity>ChangeEmitter  →  TypedEventBus.publish('<entity>_<verb>', entityId, payload)
     │  payload: { entityId, externalId, provider, changedFields?, source: 'integration' }
     ▼
  domain_events outbox  →  bridge / subscribers (trigger→action)
```

## Opt-in syntax

`integration.sink.emit_changes: true` — a boolean on the existing `sink` policy
block, alongside `delete` and `exclude_fields` (#490). Absent/false ⇒ no
emission (the back-compat default; NO schema `.default()`).

```yaml
entity:
  name: message
  pattern: Integrated
  surface: messaging
integration:
  providers:
    slack: { remote_entity: message, direction: inbound }
  sink:
    emit_changes: true     # ← opt in
```

Chosen over a top-level `emit_changes:` or an `events:` sub-block because the
emission is a property of the **integration sink path** — it belongs next to the
delete/exclude knobs that already govern that path, and reuses their parser
plumbing.

## Event payload shape

The three generated events carry (snake_case in YAML → camelCase on the wire):

| field | type | created | edited | deleted | meaning |
|---|---|:-:|:-:|:-:|---|
| `entityId` | uuid | ✓ | ✓ | ✓ | local aggregate id (also the event `aggregateId`) |
| `externalId` | string | ✓ | ✓ | ✓ | vendor external id the change keyed on |
| `provider` | string | ✓ | ✓ | ✓ | provider label (`'slack'`, `'google'`) |
| `changedFields` | json? | ✓ | ✓ | — | differ's per-field before/after map |
| `source` | string | ✓ | ✓ | ✓ | **provenance marker — always `'integration'`** |

`source: 'integration'` is the loop-breaker: a future write-back action
subscribing to these events detects integration-originated changes and declines
to echo them back to the vendor (the data-layer counterpart of the read-side
`createLoopbackMiddleware`). `changedFields` is omitted on deletes (a tombstone
has no field diff).

## Emission point — the orchestrator (and why)

The verb (created vs updated vs deleted), the external id, the local id, the
`changedFields`, and the provider all converge in exactly one place:
`ExecuteIntegrationUseCase.processChange`. It is vendor-blind and entity-agnostic
(`entityType: string`, canonical `T`), so emitting there means **zero per-sink
changes** and uniform behavior for every entity.

Because the orchestrator can't know the typed event NAME at compile time, it
depends on a thin, untyped port — `IIntegrationChangeEmitter`, bound to the
optional `INTEGRATION_CHANGE_EMITTER` token. The TYPED mapping
(`action → <entity>_<verb>`) lives in a codegen-emitted per-entity adapter where
the entity name IS known. The orchestrator injects the port `@Optional()`:

- **opted-in** entity → assembly binds `INTEGRATION_CHANGE_EMITTER` → events fire.
- **not opted-in** → token unbound → `this.emitter === null` → nothing publishes.

Emission fires only on REAL changes: never on a `noop` diff (canonical
unchanged) and never on a delete that hit no local row. A failed publish is
logged but never aborts the run (the row is already written; emission is
best-effort — the outbox `tx`, when the orchestrator drives one, gives the
at-least-once guarantee).

## Event generation

`emit_changes: true` desugars the entity into three `EventDefinition`s via the
existing entity-event pipeline (`desugarEmitChangeEvents` in
`parser/load-events.ts`, called from `desugarEntityEvents`). They merge into the
generated registry exactly like a hand-authored `events/*.yaml` — TypedEventBus
augmentation (`DomainEventRegistry`), the `EventTypeName` union, payload Zod
schemas, and registry metadata, all for free. `direction: change`,
`aggregate: <entity>`, `pool: events_change`. A top-level
`events/<entity>_created.yaml` still wins on type collision (mergeEvents is
top-level-wins) for authors who want a richer payload.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `runtime/subsystems/integration/integration-change-emitter.protocol.ts` | create | `IIntegrationChangeEmitter` port + `IntegrationChangeNotification` |
| `runtime/subsystems/integration/integration.tokens.ts` | edit | `INTEGRATION_CHANGE_EMITTER` token |
| `runtime/subsystems/integration/execute-integration.use-case.ts` | edit | `@Optional()` emitter inject + `emitChange()` calls |
| `runtime/subsystems/integration/index.ts` | edit | export the new port + token |
| `runtime/subsystems/index.ts` | edit | forward the port/token + `TYPED_EVENT_BUS` through the package barrel |
| `src/schema/entity-definition.schema.ts` | edit | `emit_changes` on `SinkPolicySchema` |
| `src/parser/load-events.ts` | edit | `desugarEmitChangeEvents` — the change-event triad |
| `src/cli/shared/change-emitter-emission-generator.ts` | create | emit `<entity>.change-emitter.ts` (@generated) |
| `src/cli/shared/assembly-emission-generator.ts` | edit | conditionally bind `INTEGRATION_CHANGE_EMITTER` |
| `src/cli/shared/adapter-emission-generator.ts` | edit | wire the change-emitter into `emitAdapters` |
| `src/cli/commands/entity.ts` | edit | print the change-emitter count |

## Backwards compatibility

Zero behavior change for entities that don't opt in: the orchestrator's emitter
is `null`, no change-emitter file is emitted, the assembly module is byte-stable.
The integration-emit snapshot (whose fixtures opt only `message` in) proves the
non-opted-in tree is unchanged.

## Generated emitter — union decoupling

The generated `<Entity>ChangeEmitter` injects `TYPED_EVENT_BUS` but types it with
a **local structural `ChangeEventPublisher` interface** (`publish(type: string,
…)`), NOT the package's `TypedEventBus` class. The package's `TypedEventBus`
carries the PACKAGE's `EventTypeName` union; the consumer's `<entity>_*` events
live in the CONSUMER registry. The structural type accepts the string literal
without depending on either compile-time union; the token resolves at runtime to
the consumer's generated bus (bound by `EventsModule.forRoot()`), which validates
the payload against the generated schema.

## Validation

- `just test-unit` — `load-events.test.ts` (desugar triad),
  `change-emitter-emission-generator.test.ts` (emitter output),
  `assembly-emission-generator.test.ts` (opt-in wiring),
  `integration-change-emit.spec.ts` (orchestrator behavior — created/edited/
  deleted/noop/miss/no-emitter/throwing/tenant).
- `test/integration-emit/` — snapshot pins the emitted `message.change-emitter.ts`
  + assembly binding; non-opted entities unchanged.
- `just test-smoke-integration` — the emitted tree (incl. the change-emitter +
  the consumer's generated `message_*` typed events) `tsc`-compiles end-to-end.

## Punted / out of scope

- **Driving the publish on the sink's transaction.** `IntegrationChangeNotification.tx`
  is reserved; today the sink owns its own transaction, so the publish is
  post-commit best-effort. Threading a single orchestrator-owned transaction
  through sink + emit (for a true in-transaction outbox guarantee) is a follow-up.
- **Custom payload per entity.** The triad payload is fixed. Authors wanting a
  richer payload override via a top-level `events/<entity>_created.yaml` (the
  mergeEvents top-level-wins seam). A per-entity payload-shape knob is not built.
- **Outbound/writeback emission.** This seam is inbound (sink) only.
