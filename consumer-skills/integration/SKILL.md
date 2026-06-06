---
name: integration
description: Load when integrating an external system (CRM, billing, etc.) in a project that ran `codegen subsystem install integration`. Triggers include implementing `IChangeSource<T>` for a provider; writing an `IIntegrationSink<T>`; registering `IntegrationModule.forRoot(...)` in `app.module.ts`; building a per-entity feature module that binds the change source, sink, and `ExecuteIntegrationUseCase`; declaring a `detection:` block in entity YAML; querying the `integration_runs` / `integration_run_items` audit log or the structured `changed_fields` jsonb; or wiring cursor persistence, diffing, and multi-tenancy.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: false
---

<!-- managed by @pattern-stack/codegen — re-run `codegen skills install` to refresh. Edit the package source, not this vendored copy. -->

# Integration Subsystem

The integration subsystem is a generic external-system integration engine for your
app. One orchestrator — `ExecuteIntegrationUseCase<T>` — runs *every* integration in
your codebase. You write per-provider detection code against a single port
(`IChangeSource<T>`) and per-entity write code against a single sink
(`IIntegrationSink<T>`). Everything else — cursor persistence, field diffing,
per-record audit, run lifecycle — is provided by the subsystem.

You opt in with `codegen subsystem install integration`, which vendors the runtime
into `<paths.subsystems>/integration/` (imported as `@shared/subsystems/integration`), adds a
`integration:` block to `codegen.config.yaml`, and emits the audit schema
(`integration-audit.schema.ts`). Unlike some subsystems, integration ships **no `generated/`
directory** — there are no codegen-emitted runtime artifacts from the base
install. (Per-entity change-source modules are emitted only if you declare a
`detection:` block in an entity YAML — see the change-sources L1 file.)

## Mental model: the five-step dance

Every integration repeats the same invariant. Steps 2–5 are machinery the
subsystem owns; step 1 is the only thing you write per provider:

1. **detect** upstream change *(you — `IChangeSource<T>`)*
2. **diff** against local state *(subsystem — `IFieldDiffer<T>`, default `DeepEqualDiffer`)*
3. **apply** the upsert or soft-delete *(your sink, called by the orchestrator)*
4. **record** the structured delta into `integration_run_items` *(subsystem)*
5. **emit** an event on success *(you — wired in your sink, optional)*

Three detection modes (poll / CDC / webhook) converge on the single
`IChangeSource<T>` port; per-mode differences live in `Change<T>` metadata, not
in separate ports.

**Integration is not events and not jobs.** Integration detects upstream change → diffs →
applies → records (`integration_runs` + `integration_run_items` pairs). It can be *triggered
by* a scheduled job (polling) or a webhook, and it can *emit* events on a
successful upsert — but the three subsystems have distinct lifecycles. See the
`jobs` and `events` skills for those.

**The audit is structured, not freeform.** `integration_run_items.changed_fields` is
`{ fieldName: { from, to } }` jsonb, validated at write time. That makes drift
queries ("when did this opportunity first become Closed Won?") one-shot SQL
filters instead of JSON scrapes.

## Wiring at a glance

`IntegrationModule.forRoot(...)` in `app.module.ts` wires the substrate — the cursor
store, run recorder, field differ, and multi-tenant flag. It is `global: true`
and **does NOT provide `ExecuteIntegrationUseCase`**. The orchestrator depends on
`INTEGRATION_CHANGE_SOURCE` + `INTEGRATION_SINK`, which are per-entity and consumer-owned, so
you register `ExecuteIntegrationUseCase` in your *feature module* alongside those
bindings. Putting it in `IntegrationModule` would force Nest to resolve those tokens
at module compile time, before your feature module is imported.

```ts
import { IntegrationModule } from '@shared/subsystems/integration';

@Module({
  imports: [
    DatabaseModule,
    IntegrationModule.forRoot({ backend: 'drizzle' }),  // 'memory' in tests
    // ... per-entity feature modules, other subsystems
  ],
})
export class AppModule {}
```

## Routing table

| When the task involves… | Read |
|---|---|
| Implementing `IChangeSource<T>` or `IIntegrationSink<T>`; the per-entity feature module; the `detection:` block + provider-keyed factory; triggering a run; multi-tenancy; loopback; testing | `change-sources-and-sinks.md` |
| The `integration_runs` / `integration_run_items` / `integration_subscriptions` shape; the structured `changed_fields` contract; worked drift / staleness / stuck-run queries; orchestrator run lifecycle and failure semantics | `audit-and-detection.md` |

## Non-obvious rules

1. **One port for three modes.** Poll, CDC, and webhook adapters all implement
   `IChangeSource<T>` with `listChanges(subscription, cursor): AintegrationIterable<Change<T>>`.
   Per-mode concerns ride in `Change<T>` metadata (`source`, `dedupKey`,
   `providerChangedFields`). Do not introduce `IPollSource` / `ICdcSource` /
   `IWebhookSource` — the union is deliberate.

2. **Cursors are opaque at the port seam, owned by the orchestrator.** Your
   adapter types its own cursor internally and yields it on each `Change<T>`.
   The orchestrator is the only reader/writer of cursor storage — never inject
   the cursor store inside a source or sink.

3. **`IntegrationModule` does NOT provide `ExecuteIntegrationUseCase`.** Register the
   orchestrator in your feature module's `providers` array next to your source
   and sink bindings.

4. **`changed_fields` is structured, validated at write.** It is
   `{ fieldName: { from, to } }`, parsed against the field-diff schema before
   insert (in both Drizzle and Memory backends). Do not treat it as freeform —
   arbitrary keys break drift queries and get rejected.

5. **The integration audit tables are subsystem-owned.** Query `integration_subscriptions`,
   `integration_runs`, and `integration_run_items` freely for dashboards, but do not write to
   them directly (bypassing the recorder's validation lands malformed data),
   and do not author entity YAMLs for them (that produces redundant
   repositories/services shadowing the subsystem).

6. **All-failed runs still advance the cursor.** If every record in a run
   fails, the run is `status='failed'` but the cursor still persists as
   last-yielded — the source kept yielding, so re-running would not re-deliver
   those records. This is the most common "wait, what?" moment; document it in
   your runbooks. Retry semantics are caller-owned.

7. **Event emission is an opt-in seam; scheduling/retry/subscription-resolution
   stay consumer concerns.** Declare `integration.sink.emit_changes: true` on an
   entity and codegen generates `<entity>_created` / `<entity>_edited` /
   `<entity>_deleted` typed events plus a `<entity>.change-emitter.ts` the
   assembly binds to `INTEGRATION_CHANGE_EMITTER`; the orchestrator then publishes
   after every real sink write/soft-delete (payload carries
   `source: 'integration'` for loop-breaking). Omit the flag (the default) and the
   orchestrator emits nothing — hand-roll emission in your sink if you need a
   bespoke payload, or override the generated event via a top-level
   `events/<entity>_created.yaml`. Scheduling is still a job/webhook concern;
   retry semantics are still caller-owned. See `docs/specs/EMIT-CHANGES-1.md`.

## Do not

- Do not introduce mode-specific ports (`IPollSource` / `ICdcSource` /
  `IWebhookSource`). One `IChangeSource<T>` for all modes.
- Do not treat `changed_fields` as freeform jsonb — the `{ from, to }` shape is
  load-bearing for drift queries and enforced at write.
- Do not provide `ExecuteIntegrationUseCase` in `IntegrationModule` — it forces eager
  resolution of consumer-owned tokens.
- Do not write directly to the integration audit tables, and do not ship entity YAMLs
  for them.
- Do not inject the cursor store inside a source or sink — the orchestrator
  owns the get/put lifecycle.
- Do not drop `tenantId` when `multi_tenant: true` — the orchestrator throws
  `MissingTenantIdError` at entry.
