# Changelog

All notable changes to this project will be documented in this file.

## [0.27.1] — 2026-06-07

### Fixed

- **Scheduled-event drain no longer claims future slots early (#533).**
  `DrizzleEventBus.processBatch()` composed a status-only claim
  (`status='pending'` [+ pool IN …]) with no readiness predicate, so the 1s
  fallback poll grabbed the `EventScheduler`'s pre-materialised *next* slot
  (`occurred_at = slotStart`, in the future) on the very next cycle and stamped
  `processed_at = now()` — contradicting `materializeScheduledEvent`'s own
  contract ("a future slot is claimed by polling once `occurred_at` passes").
  Symptoms: event-log rows reading "N minutes from now" yet already
  `status:processed`, and schedule-driven triggers firing up to one interval
  ahead of their slot. Fix: add `occurred_at <= now` to the claim WHERE (both
  the pooled and pool-less branches). Normal events publish with
  `occurred_at = now()`, so the gate is transparent to them.

## [0.27.0] — 2026-06-07

### Added

- **Pagination by default (#532): `Page<T>` list emit + `store.<entity>.useData()`.**
  See PR #532. (CHANGELOG entry backfilled in 0.27.1.)

## [0.26.1] — 2026-06-07

### Fixed

- **Sink-seam emitter (#491 Shape C): generated `*.sink.generated.ts` bases now
  compile for the relative-path (swe-brain) layout.** Two defects made every
  emitted base non-compiling when no tsconfig alias covers the module dir
  (#528):
  - **Repo import one level too deep.** The sink base lives at
    `integrations/<surface>/sinks/` (3 deep under `src/`) but reused the
    *assembly*-relative `repoImportSpecifier` (computed for
    `integrations/<surface>/modules/<provider>/`, 4 deep), emitting
    `../../../../modules/…` — which lands at the repo root, not `src/` (TS2307).
    The caller now recomputes the specifier relative to the SINK dir from the
    resolved repo file path (alias-aware via the same `toImportSpecifier`
    helper, now exported; `EntityModuleLocation` carries `repoFileAbs` /
    `moduleFileAbs`). Correct prefix: `../../../modules/…`. The assembly import
    depth is unchanged.
  - **Bare `userId,` shorthand (TS18004).** `default<E>BuildWrite(record)` is a
    standalone function with only `record` in scope, but a declared `user_id`
    field was special-cased as a bare `userId,` shorthand referencing no
    binding. `userId` is a plain projection field — now emitted as
    `userId: record.userId`, like every other copy-through field.
  - Validation: a new compile-level gate
    (`sink-swe-brain-layout.compile.test.ts`) runs the real emitter into a
    swe-brain-shaped tree (`integrations/<surface>/sinks/` +
    `modules/<plural>/<entity>.repository.ts`, no alias) and `tsc --noEmit`s the
    emitted base — the prior §3b gate missed both (it stubbed the repo import
    same-dir and used no `user_id` field). Found consuming 0.26.0 in swe-brain
    (6 bases, 12 errors).

## [0.26.0] — 2026-06-07

### Added

- **Runtime: compact console logger + `LOG_LEVEL` threshold
  (`runtime/shared/logging`).** A proven swe-brain (second-dogfood) consumer
  pattern lifted into the runtime, importable as
  `@pattern-stack/codegen/runtime/shared/logging`. `CompactConsoleLogger` drops
  Nest's ~55-char `[Nest] <pid>  - <full locale date>   LEVEL [Context]`
  preamble (which wraps 2–3× in split-pane dev TUIs) — emitting
  `12:48:42   LOG [Context] message` — and `createAppLogger(threshold?)` gives
  consumers the log-level knob the generated entrypoints never wired: a single
  `LOG_LEVEL` env threshold (`verbose < debug < log < warn < error < fatal`,
  default `log`) that enables that level and above, with an explicit-override arg
  that wins over the env (CLI tools pass `'warn'` to stay quiet). Hand it to
  `NestFactory.create(AppModule, { logger: createAppLogger() })`. See
  `docs/CONSUMER-SETUP.md` §Application logger. (The generated worker template
  doesn't auto-wire it yet — follow-up.)

## [0.25.0] — 2026-06-07

### Fixed

- **Lifecycle events: revive the audit trail + diagnosable emit failures.** The
  `BaseService` lifecycle/change event path (`runtime/base-classes/lifecycle-events.ts`)
  predates the AUDIT tier + routing schema (ADR-039) and was never migrated:
  `buildLifecycleEvent` / `buildChangeEvents` stamped no `tier`, so
  `toInsertValues` defaulted the row to `tier='domain'` with NULL `pool` /
  `direction` — which violates the `domain_events_tier_routing_check` CHECK
  (`tier='audit' ⇔ pool IS NULL AND direction IS NULL`). Result: **every**
  `BaseService` create/update/delete in every consumer paid a rejected INSERT and
  silently lost its lifecycle audit trail. The builders now stamp `tier: 'audit'`
  (lifecycle/change events are exactly audit-tier semantics — untyped audit
  records, never bridge-routed); the rows land and surface under the
  observability viewer's audit-tier toggle, and the bridge guard keeps them out
  of job routing. Discovered by the swe-brain dogfood (2× `failed to emit 3
  event(s)` per dispatcher fire — the 3 being the `[updated, field_changed,
  field_changed]` `publishMany` batch from `BaseService.update`).
- **Lifecycle events: `emitSafely` logs the cause via the Nest Logger.** The
  fire-and-forget catch was a bare `catch {}` that swallowed the error and
  printed `failed to emit N event(s)` via raw `console.warn` — bypassing the Nest
  `Logger` (so consumers configuring `app.useLogger` / factory `logger:` could
  neither format nor filter it) with zero diagnosability. Now logs via a
  module-level `Logger('LifecycleEvents')` at `warn` level including the event
  count, the distinct event types, and the error message; the stack follows at
  `debug`. Never-throw semantics preserved.

## [0.24.0] — 2026-06-06

### Added

- **Integration: opt-in post-upsert change-event emission seam.** An entity that
  declares `integration.sink.emit_changes: true` now gets typed per-entity domain
  events published automatically when integration sync upserts/soft-deletes rows.
  Codegen (a) desugars the entity into `<entity>_created` / `<entity>_edited` /
  `<entity>_deleted` events (merged into the generated events registry exactly
  like a hand-authored `events/*.yaml` — TypedEventBus augmentation, the
  `EventTypeName` union, payload schemas), and (b) emits a fully-`@generated`
  `<entity>.change-emitter.ts` that the per-entity assembly module binds to the
  new optional `INTEGRATION_CHANGE_EMITTER` token. `ExecuteIntegrationUseCase`
  injects the emitter `@Optional()` and publishes after every real sink
  write/soft-delete (never on a `noop` diff or a delete that hit no row). Payload:
  `{ entityId, externalId, provider, changedFields?, source: 'integration' }` —
  the `source` provenance marker lets a write-back action detect
  integration-originated changes and break the inbound→writeback loop. The verb
  is `_edited`, NOT `_updated` (swe-brain ADR-0009 B1). Entities that don't opt in
  are byte-for-byte unchanged (the emitter token stays unbound). Generalizes the
  emission swe-brain hand-built in its sinks. See `docs/specs/EMIT-CHANGES-1.md`.

## [0.23.0] — 2026-06-06

### Fixed

- **Jobs: claim heartbeat (CLAIM-HB-1) — long-running handlers are no longer
  swept mid-flight.** The drizzle `JobWorker` stamped `claimed_at` once at claim
  and never renewed it, while `sweepStaleClaims` reset any `running` row whose
  `claimed_at` aged past `staleThresholdMs` (default 5 min) back to `pending`.
  Consequence: ANY handler that legitimately ran longer than the threshold was
  silently re-queued and re-claimed by a second worker, running CONCURRENTLY
  with the still-live (uncancellable) original. Discovered by the swe-brain
  dogfood: a 365-day Gmail backfill could never finish inside 5 min, so it
  re-spawned a fresh concurrent mailbox walk every ~6 min for 5 days (writes
  were idempotent upserts, so no corruption — but a non-idempotent handler would
  have corrupted). Fix: a live worker now tracks its in-flight run IDs and bumps
  `claimed_at = now()` for them every `claimHeartbeatIntervalMs` (new
  `JobWorkerOptions` knob, default `staleThresholdMs / 3`). The sweeper now
  fires only for genuinely dead workers (renewal stopped) — its documented
  "stranded by a crashed worker" intent.

### Added

- **Jobs: consumer-threadable lease tuning.** `jobs.extensions.drizzle` now
  accepts `stale_threshold_ms`, `stale_sweeper_interval_ms`, and
  `claim_heartbeat_interval_ms`, threaded through the subsystem barrel generator
  into both `JobsDomainModule.forRoot` and `JobWorkerModule.forRoot` (camelCase
  runtime keys). All optional; the worker defaults the heartbeat to a third of
  the stale threshold.

> **Deferred (CLAIM-HB-1 follow-up):** fencing — a claim token on `job_run` so a
> swept-and-reclaimed run cannot be double-completed by a zombie attempt that
> finishes after the sweep. Needs a schema/migration change + write-site guards;
> tracked as issue #501. The heartbeat closes the practical
> re-claim-loop bug; fencing hardens the residual crash-recovery race.

## [0.21.0] — 2026-06-06

**FieldMeta enrichment (ADR-040, Phase A of type-aware rendering).** The
frontend emitter's per-entity field metadata now carries enough vocabulary for
consumers to build metadata-driven rendering (the swe-brain renderer kit
consumes this in its Phase B). All additive.

### Added

- **Full `ui_*` hint passthrough.** `ui_group`, `ui_visible`, `ui_placeholder`,
  `ui_help`, and `ui_format` were accepted by the schema but dropped before
  emission. They now survive parser → derivation → emitted `FieldMeta`
  (`group` / `visible` / `placeholder` / `help` / `format`). `format` was
  previously only ever the hardcoded timestamp `{ dateFormat: 'relative' }`;
  authored `ui_format` now passes through.
- **Key-field curation (qField parity).** New YAML keys `ui_key_field` +
  `ui_key_field_order` surface as `isKeyField` / `keyFieldOrder` on the row
  (the qField / EAV `field_definitions` names — one vocabulary, multiple
  homes), and `<camel>Metadata` gains `keyFields`: the ordered curated
  field-name list (sorted by `keyFieldOrder`, declaration order for ties) that
  drives card/preview field selection.
- **Family/behavior common-field bundles** (timestamps precedent): the
  `soft_delete` behavior now contributes a `deletedAt` row
  (datetime / tertiary / relative); entities whose declared fields carry the
  synced/integrated shape (both `external_id` AND `provider`) get
  `group: 'external_sync'` defaulted onto those fields (plus
  `provider_metadata` when present) — a derivation default only, authored
  `ui_group` always wins. Behavior-contributed columns (not in the parsed
  field map) still get no rows: the emitter never emits a row for a column it
  cannot see.
- **EAV `data_type` → `FieldType` contract.** `EAV_DATA_TYPE_TO_FIELD_TYPE`
  (`string→text, integer/decimal→number, boolean→boolean, date→date,
  datetime→datetime, json→json, reference→reference, picklist→enum,
  multipicklist→enum`; multi-select rendering is consumer-side) is exported
  from the package root AND emitted into every generated
  `fields/field-meta.ts`, rendered from the same source object so the copies
  cannot drift. See ADR-040 for the convergence story
  (qField/CatalogField ↔ codegen FieldMeta ↔ EAV `field_definitions`).

### Tests

- emit-fields suite: hint passthrough (incl. author-override-beats-default and
  string escaping), key-field curation + `keyFields` ordering, soft_delete /
  external-sync bundles, EAV contract completeness vs the emitted copy.
- Frontend golden fixtures now exercise the new surface; the snapshot locks
  curation ordering (`first_name` before `email` despite declaration order),
  the `deletedAt` bundle, and the `external_sync` group default.

## [0.20.2] — 2026-06-06

Two consumer-found fixes (dogfooding swe-brain on 0.20.1).

### Fixed

- **ADR-039 boot tick was lost to a module-init race.** `EventSchedulerLifecycle`
  ran `materializeBoot()` from `onModuleInit`, which fires during the EVENTS
  module's own init — BEFORE later modules (notably `BridgeModule`, whose
  outbox-drain hook turns a scheduled event into `bridge_delivery` rows) finish
  wiring. With `listenNotify` the boot row drained within ~3ms and was marked
  `processed` with ZERO deliveries and no error (verified live: slot
  `@schedule/reconcile_due/1780707600000` processed 3ms after materialisation,
  zero `bridge_delivery` rows for `reconcile-poll#0`; the in-loop tick at the
  next slot boundary delivered correctly — boot-only loss). **Fix:** the
  lifecycle now defers to `onApplicationBootstrap` (fires after all modules'
  `onModuleInit` + every hook is attached), so the boot tick drains against the
  fully-wired pipeline. The tick interval start moved with it (both passes live
  in `EventScheduler.start()`). Regression tests assert the hook surface is
  `onApplicationBootstrap` (not `onModuleInit`) and that a boot-materialised
  scheduled event reaches a subscriber attached after init.
- **#473 — `subsystem install observability` never wired `ObservabilityModule`.**
  The install added `observability` to `subsystems.install` but the barrel
  emitter had no composer, so `ObservabilityModule.forRoot` was never emitted
  into `SUBSYSTEM_MODULES` — consumers hand-wired it in `app.module.ts` (like
  Auth). **Fix:** added an `observability` composer. It emits
  `ObservabilityModule.forRoot()` (no `backend`/`multiTenant` — a combiner per
  ADR-025 owns no durable state), imported package- or vendored-aware, and is
  ordered LAST in `COMPOSABLE_ORDER` so its `forRoot` registers AFTER the
  events/jobs/bridge/integration read ports it composes via `@Optional()` DI.
  The `observability.reporters` block (OBS-6) is threaded into `forRoot` only
  when a reporter is `enabled: true` (off-by-default, mirroring the
  `listen_notify` / `differ` clauses); the default install stays a bare
  `ObservabilityModule.forRoot()`. Closes #473.

### Tests

- `subsystem-barrel-generator` tests: observability composer coverage (both
  modes, combiner ordering after the composed siblings, reporters threaded only
  when enabled).
- **Subsystems smoke now asserts forRoot presence per installed subsystem** (not
  just events' `eventRegistry`) — it installs observability too and fails if the
  real generated barrel is missing any installed subsystem's `forRoot` or if
  observability isn't ordered after the read ports. Both gap classes (the
  scheduler threading and the missing observability wiring) survived because
  nothing end-to-end checked per-subsystem wiring.

## [0.20.1] — 2026-06-06

**Fix: the subsystems barrel never threaded `eventRegistry` into
`EventsModule.forRoot`** — so `EventSchedulerLifecycle` never spawned and
ADR-039 scheduled events silently didn't tick (dogfood gap found consuming
0.20.0 in swe-brain, package mode). The 0.20.0 runtime expected the barrel to
pass the consumer's generated `eventRegistry`, but the emitter (`subsystem-
barrel-generator`) was never updated to do so.

### Fixed

- **`subsystem-barrel-generator` now threads `eventRegistry`** into
  `EventsModule.forRoot` on every events branch (package + vendored, plain +
  `listenNotify`). The registry is imported from `./events/registry`
  (package mode) or `<subsystemsRoot>/events/generated/registry` (vendored) —
  the same conditioning/relative-import mechanism the `TypedEventBus` import
  already uses. `EventSchedulerLifecycle` reads `eventRegistry` (and only it —
  no bundled fallback), so this is what makes the scheduler spawn.
- **Stub guard extended to vendored mode.** A bare `subsystem install events`
  regenerates the barrel before `entity new --all` has emitted the generated
  events set; the writer drops the empty 5-file set (incl. `registry.ts`) into
  the vendored `<subsystemsRoot>/events/generated/` if absent, so the barrel's
  new `eventRegistry` import never dangles (package mode already had this guard
  for `./events/bus`; the same path emits `registry.ts`).

### Tests

- `subsystem-barrel-generator` tests updated for the new `forRoot` shape +
  a both-modes regression guard asserting `eventRegistry` is imported AND
  threaded.
- **Subsystems smoke now asserts the threading end-to-end** — the gap survived
  because nothing checked that a consumer's barrel actually wires the scheduler.
  `run-smoke-subsystems` now fails if the real generated barrel doesn't import
  `eventRegistry` and pass it to `EventsModule.forRoot`.

## [0.20.0] — 2026-06-06

**Declarative time-based scheduling: time as an event source** (ADR-039;
swe-brain consumer-test finding — an hourly reconcile poll had to be hand-rolled
as a self-perpetuating job chain because there was no time-based trigger, and
its flat dedupe key collapsed the chain into the running parent).

### Added

- **`schedule:` on event YAML** (`definitions/events/<domain>/*.yaml`) —
  `{ every, align?, catchUp?, maxCatchUpSlots? }`. Declares that the platform
  emits this event on a cadence. `every` is a duration string (`'1h'`/`'30m'`/
  `'15s'`/`'500ms'`/`'1d'`) or raw ms. Domain-tier only (audit rejected). Time
  is a third event **source** (peer to use-case publishes + webhook receivers),
  not a fourth activation tier — consumers react through ADR-023's existing
  tiers (`subscribe` or `@JobHandler({ triggers })`); no new activation
  mechanism. Carried into the generated `eventRegistry` + `EventMetadata`.
- **`EventScheduler`** (`runtime/subsystems/events/event-scheduler.ts`) — a
  strict producer that materialises **exactly one `domain_events` row per
  (type, slot)** on a cadence; the existing outbox drain + bridge activate them.
  Reconcile-on-boot (materialise the current slot, or bounded `catchUp`
  backfill) + a tick pass for the next slot. Wired by `EventsModule.forRoot`
  for the drizzle + memory backends (the Redis bus retains no outbox history, so
  slot idempotency can't be enforced there). Pure helpers exported:
  `parseEvery`, `slotStartFor`, `nextSlotStart`, `slotKeyFor`,
  `scheduledEventsFromRegistry`.
- **Partial UNIQUE expression index** `idx_domain_events_schedule_slot` on
  `(type, metadata->>'scheduleSlot')` — the DB-level exactly-once-per-slot
  invariant (no advisory lock, no leader election; multi-instance + boot/tick
  races collapse on it). Partial on the slot key so ordinary events are
  untouched. Additive Atlas migration.
- **`ScheduleConfigError`** + `IEventBus.materializeScheduledEvent` /
  `lastScheduledSlotMs` (both backends).

### Misfire policy

- Down across N slots → on recovery, materialise **one** tick for the current
  slot (don't replay the misses). `catchUp: true` opts into bounded backfill.

### Provenance

- A scheduled tick carries `metadata.triggerSource = 'schedule'` +
  `metadata.scheduleSlot`. A bridge run from it reads `job_run.trigger_source =
  'event'`; the clock origin is joinable via `trigger_ref → domain_events.id`.
  The dormant ADR-022 `triggerSource: 'schedule'` enum is the correct stamp for
  the **direct-start** path (a Tier-1 subscriber calling `orchestrator.start(…,
  { triggerSource: 'schedule' })`).

### Retires

- The self-perpetuating job-chain pattern (a handler enqueuing its own
  successor) and its slot-keyed-dedupe workaround — replaced by a `schedule:`
  YAML + a `triggers:` entry. Supersedes the dangling "ADR-025 scheduling
  territory" pointer in `docs/specs/BULLMQ-1.md` (the future BullMQ backend maps
  `schedule:` onto `upsertJobScheduler`; the YAML contract is identical).

## [0.19.0] — 2026-06-05

**Providers catalog emission + planned providers** (ADR-038 follow-on;
swe-brain consumer-test finding — the Connections surface hand-duplicated
provider knowledge that `definitions/providers/*.yaml` already owns).

### Added

- **Frontend providers catalog (`generated/providers.ts`)** — emitted by the
  frontend whole-set emitter when `definitions/providers/` exists (entity-only
  consumers see no new file; the root barrel gains the export conditionally).
  `PROVIDERS` (flat, slug-sorted) + `PROVIDER_CATALOG` (grouped by
  `display.category` into the ordered `frontend.catalog.categories`). Providers
  are gen-time knowledge — the catalog is emitted, not queried.
- **`display:` block on the provider schema** (`category`, `blurb`, `hint`) —
  presentation metadata consumed only by the catalog emission; backend
  provider/adapter codegen ignores it.
- **`status: active | planned` on the provider schema** (default `active`).
  `planned` providers are roadmap stubs: catalog tile only — `auth`/`client`
  optional, surface closed-set + import pre-flight cross-checks skipped (slug
  uniqueness still enforced), and ALL backend emission (provider modules,
  adapters, assemblies) filters them out. Flip to `active` when the
  integration lands.
- **`frontend.catalog.categories`** in `codegen.config.yaml` — ordered display
  groups (`id`, `name`, `blurb`) the catalog renders.

### Changed

- `generateProviderModule` / `generateAdapterScaffold` now take
  `ActiveProviderDefinition` (auth/client guaranteed); use the exported
  `isActiveProvider` guard to narrow.

## [0.17.2] — 2026-06-04

**Shutdown leak fix** (LISTEN-NOTIFY-2; swe-brain dogfood). With
`listen_notify: true` (the LISTEN/NOTIFY wake extension shipped in 0.16.0), a
Nest app that booted and then `app.close()`d — e.g. a boot-check / CI smoke step —
never exited: at least one `LISTEN codegen_jobs_wake` client survived
`app.close()`, holding an ESTABLISHED Postgres socket open forever (two swe-brain
CI runs hung for hours). Backward-compatible; affects only consumers that opted
into `listen_notify`.

### Fixed

- **`PgNotifyListener.stop()` is race-safe against an in-flight `connect()`**
  (LISTEN-NOTIFY-2 RC1 — the defect that actually fired). `connect()` checked
  `this.stopped` only at entry, then `await pool.connect()`, wired handlers,
  issued `LISTEN`, and assigned `this.client` last. A `stop()` arriving during
  the checkout await ran `releaseClient()` against a still-null `this.client`
  (released nothing); the resuming `connect()` then assigned the client and
  issued `LISTEN` — leaking a checked-out connection with no owner left to
  release it. With 5–6 listeners (one per jobs pool + the events drainer) all
  starting at bootstrap and a tight `app.close()`, the race fired on ~1 of 6
  listeners — exactly the observed signature (one survivor, the rest clean).
  Now `connect()` re-checks `stopped` after the checkout AND after `LISTEN`,
  destroying the just-acquired client and bailing before assignment; `stop()`
  tracks and awaits the in-flight connect promise before its own release, so
  `app.close()` can't return while a checkout is still mid-flight. Releases use
  `release(true)` (destroy) so a half-listening socket is never reused.
- **`JobWorker.onModuleDestroy` stops the wake listener on EVERY destroy path**
  (LISTEN-NOTIFY-2 RC2 — latent). The listener `stop()` lived only on the first
  (non-`shuttingDown`) branch, so a SIGTERM-then-Nest double-destroy hit the
  `if (this.shuttingDown) { …; return; }` early return and skipped it, leaking
  the listener under the normal SIGTERM shutdown path. Teardown is now an
  idempotent `stopNotifyListener()` called unconditionally at the top of every
  destroy. `DrizzleEventBus` already stopped its listener unconditionally; it
  shared `PgNotifyListener` and so benefits from the RC1 fix directly.

## [0.17.1] — 2026-06-04

**Two dogfood fixes that bit the same swe-brain mutation drain** (ADR-0009
Amendment B): the jobs orchestrator silently dropped function-form
concurrency/dedupe keys, and the integration differ unconditionally ignored
`deletedAt`. Both are honored now; both are backward-compatible.

### Fixed

- **`@JobHandler` function-form `concurrency.key` / `dedupe.key` are honored
  end-to-end** (JOB-FN-KEY; swe-brain ADR-0009 Amendment B §B3). The typed API
  (`ConcurrencyPolicy.key`/`DedupePolicy.key`) had ALWAYS required a function,
  but registration (`upsertJobRows`) stored only `typeof key === 'string' ? key
  : null` — a function key persisted as a NULL `concurrency_key_template`, so
  `start()` wrote a NULL `job_run.concurrency_key` and the worker's queue-release
  gate (which keys off `claimed.concurrencyKey`) never engaged. Observed in
  swe-brain: three `inbound-sync` runs the handler believed shared one
  `collisionMode: 'queue'` lane ran fully concurrently, three `integration_runs`
  racing one message row. Now both backends persist a function key as the
  `FN_KEY_SENTINEL` marker (non-null, so the collision/dedupe path engages, and
  hash-stable so the definition-hash gate doesn't churn) and re-resolve the live
  function from `JOB_HANDLER_REGISTRY` at `start()`. A `FN_KEY_SENTINEL` with no
  live function throws `JobKeyFunctionUnavailableError` (fail loud, never
  silently degrade to no-key). Drizzle + memory + BullMQ (which delegates to the
  Drizzle `start`) all agree.

### Changed

- **`ConcurrencyPolicy.key` / `DedupePolicy.key` widen to
  `JobKeySelector<TInput> = string | ((input) => string)`.** The string form is
  documented as a `{{field}}` template (evaluated by `evaluateKeyTemplate`); the
  function form is the one that previously type-checked but was dropped. Existing
  function keys now WORK (were silently no-key before); existing string-template
  keys behave identically. New exports from `@pattern-stack/codegen/runtime/*`
  jobs: `JobKeySelector`, `FN_KEY_SENTINEL`, `keySelectorToTemplate`,
  `resolveJobKey`, `JobKeyFunctionUnavailableError`.

### Added

- **`DeepEqualDifferOptions.unignore`** — the inverse of `ignore`, subtracted
  from the default ignore set after the merge (DIFFER-UNIGNORE; swe-brain
  ADR-0009 Amendment B §B4). Lets a consumer declare that a normally-metadata
  column is DOMAIN DATA for their entity. The canonical case: an entity with
  `softDelete: false` whose `deletedAt` carries a vendor-observed retraction
  tombstone ON the canonical record (a Slack `message_deleted` → `deletedAt`,
  ADR-0008 §1). `deletedAt` is in `DEFAULT_IGNORE_FIELDS`, so the tombstone
  overlay diffed to `'noop'` → the upsert was skipped → `deleted_at` never
  landed (observed: `integration_run_items` `{operation: noop, changed_fields:
  {}}` for every delete). `new DeepEqualDiffer({ unignore: ['deletedAt'] })` now
  makes the field register as a change. `unignore` wins over a field also in
  `ignore`; un-ignoring a field not in the set is a harmless no-op; per-instance
  (never mutates `DEFAULT_IGNORE_FIELDS`).
- **`IntegrationModuleOptions.differ` + `integration.differ.{ignore,unignore}`
  config threading.** `IntegrationModule.forRoot({ differ: { unignore:
  [...] } })` threads into the default `DeepEqualDiffer` bound to
  `INTEGRATION_FIELD_DIFFER`, and the subsystem barrel generator emits that
  `forRoot` option from `integration.differ.*` in `codegen.config.yaml` (same
  off-by-default config-threading shape as 0.16.0's `listen_notify`; vendored +
  package mode both covered). A feature module that binds its own
  `IFieldDiffer<T>` still overrides entirely.

### Docs

- Differ header comment + `integration` consumer skill (`audit-and-detection.md`,
  `protocols-and-ports.md`) document the `unignore` knob and the
  `integration.differ.*` config path; the `integration-config` codegen.config
  template gains a commented `differ:` block.

## [0.17.0] — 2026-06-04

**`ActivityPattern` subject scoping is config-driven** (ACTIVITY-SUBJECT-1) —
the library's Activity base classes no longer bake the CRM term "opportunity"
into their finders. An activity/interaction entity declares which subject it is
scoped to via the pattern's new `config:` block, and the generated repo/service
expose generic, config-resolved subject lookups. Surfaced by the swe-brain
dogfood, whose interactions (meeting, email, transcript, message) reference
`person`/`repo`/`team` subjects (ADR-0006), not CRM opportunities.

Consumer census confirmed **no project used the Activity pattern** (dealbrain's
sole `findByOpportunityId` is a `JunctionSyncRepository` method, not the pattern;
swe-brain's interactions are all `pattern: Integrated`), so this is a clean cut
with no aliases per the "no backwards compatibility until users" rule. The
`patterns: [Integrated, Activity]` composition — the swe-brain target — is
validated and tested.

### Added

- **`ActivityPattern.configSchema`** — `{ subject?, subjectColumn?, occurredAt? }`
  (all optional, `.strict()`). `subject` derives the FK column `<subject>_id`;
  `subjectColumn` overrides it explicitly; `occurredAt` names the recency column
  (default `occurred_at`). Validated at parse time via the standard ADR-031
  composition path; emitted onto the concrete repo as `patternConfig` (the same
  hand-off `IntegratedEntityRepository` uses for `integrationConfig`).
- **`ActivityPatternConfig`** interface exported from
  `runtime/base-classes/activity-entity-repository.ts`.

### Changed

- **`ActivityEntityRepository` finders are config-driven.**
  `findByOpportunityId` / `findRecentByOpportunityId` are replaced by
  `findBySubjectId` / `findRecentBySubjectId`, which resolve the subject FK column
  (and recency-ordering column) from `this.patternConfig` at runtime. Calling a
  subject finder with no subject configured throws a clear error naming the
  config key to set. `findByDateRange` and `findByUserId` are unchanged (actor
  scoping is generally applicable, not CRM-shaped).
- **`ActivityEntityService`** mirrors the rename: `findBySubject` /
  `findRecent` (was `findByOpportunity` / `findRecent`); `IActivityEntityRepository`
  drops the opportunity methods for the subject ones. `findByDateRange` /
  `findByUser` unchanged.
- **`ActivityPattern` inherited-method comment strings** now advertise the
  subject finders; the header's byte-identical-to-FAMILY_MAP claim is removed (it
  was a one-time PATTERN-5 migration guarantee, not a standing contract).

### Migration

No consumer action required — no project used the Activity pattern. A project
adopting it now declares `pattern: Activity` (or `patterns: [Integrated,
Activity]`) plus `config: { Activity: { subject: <entity> } }`. Named per-subject
finders (`findByPersonId`) remain available the same way they always were — via
the entity's declarative `queries:` block.

## [0.16.1] — 2026-06-04

**`WebhookFetchCallback<T>` yields `{ record, eventId?, cursor? }`** —
`WebhookChangeSource` now prefers a queue-yielded `eventId` for
`Change<T>.dedupKey` (gap #6 follow-through, swe-brain ADR-0009 Amendment B
§B5). swe-brain's Slack inbound drain documented an `eventIdField: 'externalId'`
substitution — delivery dedup happens at the receiver, so record identity stood
in for event identity. That substitution becomes genuinely unsafe once a message
and its edit (same `externalId`, different vendor event) can share one drain
batch — they'd collapse to a single `dedupKey`. Vendor delivery metadata (the
event id) should never need a field on the vendor-neutral canonical record; the
queue-yield is the right channel for it. Backward-compatible: callbacks that
yield `{ record, cursor? }` and configs that set `webhook.eventIdField` are
unchanged; opting into `eventId` is the only migration, and it's optional.

### Changed

- **`WebhookFetchCallback<T>` yield shape** is now `{ record: T; eventId?:
  string; cursor?: WebhookCursor }` (was `{ record: T; cursor?: WebhookCursor }`)
  — the new `eventId` is opt-in and additive; existing callbacks compile and run
  unchanged.
- **`WebhookChangeSource.dedupKey` precedence** is now **yielded `eventId` >
  `webhook.eventIdField` record extraction > undefined**. A non-empty yielded
  `eventId` always wins; otherwise the configured `eventIdField` is read off the
  emitted record (and still throws if the field is configured but absent on the
  record); with neither, `dedupKey` is `undefined` (the orchestrator simply has
  no delivery-level dedup signal for that change).
- **`detection-config.schema.ts`: `webhook.eventIdField` is now optional**
  (`z.string().min(1).optional()`). A callback that always yields `eventId` need
  not declare a record field for it. The `webhook` block itself stays
  structurally required in webhook mode (an empty `{}` is valid; a missing block
  is not), so the existing "webhook-mode missing webhook block" validation is
  unaffected.

### Docs

- ADR-033 §1 amended (the `webhook: { eventIdField? }` shape + the yield channel
  + dedupKey precedence), integration `SKILL.md` + consumer
  `change-sources-and-sinks.md` updated to the yield-preferred precedence.

## [0.16.0] — 2026-06-04

**Postgres LISTEN/NOTIFY wakeups** for the jobs worker + events outbox drainer
(LISTEN-NOTIFY-1, dogfood gap #7 — swe-brain's live-inbound latency). The
scaffold has documented `jobs.extensions.drizzle.listen_notify` since JOB-6 and
`JobsDomainModule` reserved the typed slot, but neither knob was wired (no
runtime, and the barrel never threaded `jobs.extensions.drizzle.*` into
`JobWorkerModule.forRoot`). This makes both real.

NOTIFY wakes the polling loop the instant work becomes claimable; **interval
polling remains the safety net** (alongside, never instead). Every `pg_notify`
is emitted **inside the same transaction** as the row write it announces, so
Postgres delivers it only on commit — durability is byte-for-byte unchanged. A
lost notification (listener down, transaction-mode pooler) degrades to today's
poll latency, never to lost work.

Measured on swe-brain's inbound spine (webhook → outbox drain → bridge wrapper →
user job): **~1.4–3.0 s → sub-500 ms** with `listen_notify: true`, zero
durability change.

### Added

- **`runtime/subsystems/jobs/pg-notify.ts`** — `PgNotifyListener` (dedicated
  listener connection off `DRIZZLE.$client`, debounced dispatch,
  reconnect-with-capped-backoff, WARN-once degradation) + in-tx `pgNotify(tx,
  channel, payload)` + channel constants. Shared by jobs + events.
- **Jobs worker** — `JobWorkerOptions.listenNotify`; LISTEN on
  `codegen_jobs_wake`, a notify for the worker's pool drives an immediate
  debounced claim cycle. `DrizzleJobOrchestrator.start()` emits the in-tx wake
  on enqueue, gated on the new `JOBS_LISTEN_NOTIFY` token (provided from
  `jobs.extensions.drizzle.listen_notify`).
- **Events drainer** — `EventsModuleOptions.listenNotify`; LISTEN on
  `codegen_events_wake`, `publish`/`publishMany` emit the in-tx wake; a
  pool-filtered drainer wakes only for its lanes.
- **Bridge** — the `BridgeOutboxDrainHook` wrapper `job_run` insert emits the
  jobs wake in the per-event drain tx, so reserved-pool wrappers wake too.
- **Generator threading** — `jobs.extensions.drizzle.{listen_notify,
  poll_interval_ms}` flow into the generated barrel's `JobsDomainModule.forRoot`
  + embedded `JobWorkerModule.forRoot({ domainModuleExtensions: { drizzle: …
  } })`; `events.extensions.drizzle.listen_notify` flows into
  `EventsModule.forRoot({ listenNotify })`. Package and vendored emission both
  covered. (The runtime already honored `JobWorkerOptions.pollIntervalMs`; it
  just never received a config value — now it does.)
- Scaffold config comments + jobs skill updated to implemented reality, with the
  **PgBouncer caveat**: LISTEN/NOTIFY requires a direct (or session-mode)
  connection — session-scoped `LISTEN` does not survive a transaction-mode
  pooler; behind one the feature degrades to polling.

## [0.15.3] — 2026-06-03

Package-mode **inbound webhook drain** — the first real exercise of
`WebhookChangeSource` by a `runtime: package` consumer (swe-brain's Slack
inbound pipeline-parity drain, ADR-0009 §6). One latent transposition this path
exercises; the fix is framework-only.

### Fixed

- **`WebhookChangeSource` (and the identically-shaped `PollChangeSource`) now
  derive `Change<T>.externalId` from the mapping `source`, not `target`.** Both
  primitives located the `DetectionConfig` mapping entry with `target ===
  'external_id'` correctly, then read the emitted record off
  `mapping.target` — a transposition. Mapping semantics are `{ source: <field on
  the emitted record>, target: <canonical column> }`, and `fetch()` reads
  `record[externalIdSourceField]` off the emitted record, so it must use
  `.source`. The two diverge only when the canonical record is vendor-neutral
  camelCase (`source: 'externalId'` → `target: 'external_id'`): such a consumer
  hit `record missing string 'external_id'` and the primitive was unusable. The
  original unit fixtures masked it by keying records `external_id` (== the
  target). Regression tests now cover the camelCase consumer shape directly.

### Added

- **Webhook/poll/detection symbols re-exported from
  `@pattern-stack/codegen/subsystems`.** `WebhookChangeSource`,
  `WebhookChangeSourceOptions`, `WebhookFetchCallback`, `WebhookFetchContext`,
  `WebhookCursor`, `buildChangeSource`, `DetectionConfigSchema`,
  `DetectionConfig` (+ poll equivalents) were previously reachable only via the
  deep `.../integration/index` path; they now ride the public barrel alongside
  the curated `IncrementalReadBase` / `ExecuteIntegrationUseCase` forwards.

## [0.15.2] — 2026-06-03

Package-mode **bridge *delivery*** — the first time a `runtime: package` consumer
(ADR-037) drives a real event→bridge→job round-trip end to end (webhook →
`domain_events` outbox → `bridge_delivery` → wrapper `@framework/bridge_delivery`
run → user `@JobHandler`). Three latent defects only this path exercises (codegen's
own tests are vendored — a single `tsc` compilation, a single in-memory Map, and a
mocked `tx` that never touches a real FK — so none of them ever surfaced). All three
fixes are framework-only; vendored mode is unaffected.

### Fixed

- **Stateful module-singletons are no longer duplicated across dist entry
  chunks** (`tsup.config.ts`: `splitting: false` → `splitting: true`). The
  published bundle is ESM and multi-entry — `runtime/**/*.ts` each emit a physical
  `dist/runtime/.../x.js` so the `./runtime/*` wildcard `exports` map resolves 1:1.
  With splitting off, esbuild INLINED every shared module into each importing entry
  chunk. Harmless for pure functions, but a correctness bug for a stateful
  singleton: `runtime/subsystems/jobs/job-handler.base`'s `JOB_HANDLER_REGISTRY`
  Map (and its `HandlerRegistry` read facade), which the `@JobHandler` decorator
  mutates at import time, got a **second copy** inlined into the `bridge/*` chunk.
  The framework's own `@JobHandler('@framework/bridge_delivery')`
  (`BridgeDeliveryHandler`, bridge chunk) registered into the BRIDGE copy while the
  jobs `JobWorker` read the JOBS copy → the worker never upserted the wrapper's
  `job` row → the bridge's outbox-drain couldn't spawn the wrapper `job_run` (its
  `job_type` FKs `job(type)`), so the `bridge_delivery` insert violated its
  `wrapper_run_id → job_run` FK and looped forever. `splitting: true` hoists each
  shared module into a SINGLE shared chunk that every entry imports, collapsing the
  registry back to one Map. The named per-entry output files are preserved (each
  entry stays a physical `dist/runtime/.../x.js`), so the wildcard `exports` map and
  the deep consumer subpaths (`…/subsystems/jobs/index`, `…/bridge/index`,
  `./subsystems`) still resolve. ESM-only build ⇒ no CJS output to regress. Guarded
  by a new dist-grep regression test.
- **`BridgeOutboxDrainHook` now inserts the wrapper `job_run` BEFORE the
  `bridge_delivery` that references it** (`bridge-outbox-drain-hook.ts`).
  `bridge_delivery.wrapper_run_id → job_run(id)` is a plain (non-deferrable) FK, so
  the referenced wrapper run must exist before the delivery row is inserted —
  otherwise Postgres rejects the delivery insert immediately. The drain previously
  inserted the delivery (with `wrapper_run_id` set) first, then the wrapper run; the
  unit tests mocked `tx`, so the ordering was never validated against a real FK.
  Idempotency is preserved: the delivery keeps its `ON CONFLICT (event_id,
  trigger_id) DO NOTHING RETURNING`, and when it conflicts (outbox replay or
  facade-eager Case B) the speculatively-inserted wrapper run is DELETEd in the same
  tx, so a skipped delivery leaves no orphan `job_run`.
- **`JobWorker.nextStepSeq` no longer array-destructures the raw `db.execute()`
  result** (`job-worker.ts`). `db.execute(sql\`…\`)` is driver-shape-dependent and
  not uniformly array-iterable: `drizzle-orm/node-postgres` returns the pg `Result`
  OBJECT (`{ rows, rowCount, … }`), so `const [row] = await this.db.execute(...)`
  threw `TypeError: {} is not iterable`. Every wrapper `@framework/bridge_delivery`
  run calls `ctx.step` → `nextStepSeq`, so the delivery failed on every attempt. The
  result is now normalised to a row array before reading, tolerating both the
  node-postgres `{ rows }` shape and a plain-array shape. Guarded by a new unit test.

## [0.15.1] — 2026-06-02

Package-mode **bridge/trigger event typing** — the fourth and final package-mode
seam (after 0.14.1 subsystems, 0.14.2 bridge, 0.15.0 events). Lets a package-mode
consumer (`runtime: package`, ADR-037) author a `@JobHandler({ triggers: [{ event:
'<their_event>', map, when }] })` on their OWN event and have it typecheck with
full per-event payload typing. Vendored mode is byte-stable; everything here is
additive.

### Fixed

- **`@JobHandler.triggers` and the generated `bridge-registry.ts` now accept a
  package-mode consumer's own events.** Previously the bridge + job-trigger types
  (`BridgeRegistry`, `BridgeTriggerEntry<T>`, `JobTrigger<TInput>`) keyed off
  `EventTypeName` imported from the bundled `events/generated/types.ts` — which
  in the published package is codegen-patterns' OWN test-fixture union
  (`contact_created`, `deal_created`, …). A consumer's
  `'inbound_webhook_received'` trigger therefore failed to typecheck
  (`'inbound_webhook_received' is not assignable to '"contact_created" | …'`) and
  their generated `bridge-registry.ts` reported "does not exist in type
  'BridgeRegistry'". The bridge/trigger types now key off an **augmentable
  `DomainEventRegistry`** (see below) instead of the bundled fixture union, so in
  the consumer's tsc program they resolve THEIR event union with full
  `EventOfType<T>` payload typing (`e.payload.<field>` is typed, not `unknown`).
  The bundled fixture-based runtime tests stay green: the bundled `TypedEventBus`
  still keys off its local `events/generated/types.ts`, and the fixtures are
  never registered into `DomainEventRegistry`, so they never leak into a
  consumer's `EventTypeName`.

### Added

- **`DomainEventRegistry` — an augmentable, empty event registry interface**
  (`runtime/subsystems/events/event-registry.ts`, re-exported from the events
  index barrel). `EventTypeName` now derives from it
  (`keyof DomainEventRegistry extends never ? string : keyof DomainEventRegistry &
  string`) and `EventOfType<T>` resolves a registered event's concrete interface
  (falling back to the structural `DomainEvent` base otherwise). Empty in the
  package and in any no-events project ⇒ `EventTypeName` degrades to `string` and
  the bridge/trigger types stay sound (`Record<string, …>` / `(e: DomainEvent) =>
  …`) — exactly the loose shape the package's own fixture tests rely on. The five
  bridge/jobs runtime files that consumed `EventTypeName` / `EventOfType` from the
  bundled `events/generated/types` (`bridge.protocol`, `job-handler.base`,
  `event-flow.service`, `bridge-outbox-drain-hook`, `bridge-delivery-handler`) now
  import them from this augmentable seam.
- **Event codegen emits a package-mode `declare module` augmentation.** In
  package mode the generated `src/generated/events/types.ts` now appends a
  `declare module '@pattern-stack/codegen/runtime/subsystems/events/index' {
  interface DomainEventRegistry { '<type>': <Type>Event; … } }` block that
  declaration-merges the consumer's events into the runtime's registry through
  the events index module specifier (the stable, public augmentation target).
  Gated on `mode === 'package'` and a non-empty event set; vendored mode emits
  nothing (the bridge/job types import the consumer's vendored `./generated/types`
  directly), so vendored output is byte-stable. Proven end-to-end with a real
  cross-`node_modules` consumer typecheck (declaration merging across the package
  boundary is finicky and is covered by a real-tsc unit test, not string
  assertions alone): an unregistered event type is rejected, and a registered
  one's trigger `map` reads `e.payload.<field>` fully typed.

## [0.15.0] — 2026-06-02

Package-mode consumer **events** — the seam that lets a project consuming the
runtime from the package (`runtime: package`, ADR-037) declare its own
`events/*.yaml`, get a typed `TypedEventBus`, and publish typed domain events.
Completes the package-mode story alongside 0.14.2's bridge fixes. Vendored mode
is byte-stable; everything here is additive.

### Added

- **`EventsModuleOptions.typedBus?: Type<unknown>`** — binds a consumer-supplied
  `TypedEventBus` class to `TYPED_EVENT_BUS` (via `forRoot`). Omitted ⇒ falls
  back to the bundled `./generated/bus` (which IS the consumer's generated file
  in a vendored tree), so existing consumers and tests are unaffected. Nest
  constructs the supplied class with this module's `EVENT_BUS` +
  `EVENTS_MULTI_TENANT` providers (string-valued tokens match across the package
  boundary).

### Fixed

- **Event codegen is package-mode-aware.** Previously `entity new --all` in
  package mode wrote the five generated event files
  (`types/schemas/registry/bus/index.ts`) into a stray
  `src/shared/subsystems/events/generated/` tree whose `../event-bus.protocol` /
  `../events.tokens` / `../events-errors` imports don't exist in package mode —
  the tree didn't typecheck and was orphaned (the bundled empty `TypedEventBus`
  won at runtime). Now in package mode the files land in the consumer's
  `src/generated/events/`, those three runtime imports resolve through the
  published `@pattern-stack/codegen/runtime/subsystems/events/index` barrel, and
  the subsystem barrel threads the generated `TypedEventBus` into
  `EventsModule.forRoot({ typedBus })`. A package-mode consumer's typed
  `publish<'…'>()` now resolves against THEIR event union and stamps the right
  `pool` / `direction`.
- **Scope-entity-type is package-mode-aware** — relocated to
  `src/generated/scope-entity-type.ts` (a self-contained zod-only union) instead
  of the stray vendored `jobs/generated/` path.
- **Package-mode bridge trigger validation now runs.** Because the consumer's
  event registry now exists at a real path (`src/generated/events/registry.ts`),
  the bridge registry generator validates `@JobHandler.triggers` event types
  against it (the 0.14.2 "known gap"). `subsystem install events` drops an
  empty-set `src/generated/events/` stub so the barrel's `./events/bus` import
  never dangles before the next `entity new`.

## [0.14.2] — 2026-06-02

Package-mode bridge fixes — the two gaps that left the event→job bridge wired but
inert when the runtime is consumed from the package (`runtime: package`, ADR-037)
rather than vendored. Both are follow-ons to 0.14.1's package-mode subsystem
support. Vendored mode is unchanged; these are additive.

### Fixed

- **Embedded worker now drains the reserved `events_*` bridge pools.** The
  subsystem barrel emitted `JobWorkerModule.forRoot({ mode: 'embedded' })` with no
  pool list, so the in-process worker polled only `interactive` + `batch` and
  bridge wrappers sat pending forever (the BRIDGE-8 footgun, just past the boot
  guard). When `bridge` is in `subsystems.install`, the embedded worker now
  defaults to `allPools: true` (every lane in-process — exactly the knob
  `BridgeModule`'s reserved-pool guard short-circuits on).
- **A package-mode consumer's `@JobHandler.triggers` now bind.** Previously
  `BridgeModule` hardwired the bundled `./generated/registry` placeholder (frozen
  `{}` inside the package), and the registry generator skipped entirely in package
  mode (it gated on a vendored `bridge.protocol.ts` that doesn't exist), so no
  event ever routed to a job. The registry is now generated into the consumer's
  `src/generated/bridge-registry.ts` (type imported from
  `@pattern-stack/codegen/runtime/subsystems/bridge/index`, install gated on
  `subsystems.install`) and threaded into `BridgeModule.forRoot({ registry })` by
  the barrel. `subsystem install bridge` drops an empty-registry stub so the
  import never dangles before the next `entity new`.

### Added

- **`BridgeModuleOptions.registry?: BridgeRegistry`** — lets the generated barrel
  supply the consumer's scanned registry. Omitted ⇒ falls back to the bundled
  `./generated/registry` (which IS the consumer's generated file in vendored
  mode), so existing consumers and tests are unaffected.
- **`jobs.worker_pools: string[]` and `jobs.all_pools: true`** config knobs on the
  embedded worker. Precedence: explicit `worker_pools` (→ `pools: [...]`) >
  `all_pools` (→ `allPools: true`) > bridge-installed default (`allPools: true`) >
  the non-reserved default (unchanged).

### Known gaps

- Package-mode trigger-event **validation** against the events registry is skipped
  (the event codegen generator is not yet mode-aware, so its registry isn't found
  under the package-mode generated path). Triggers still generate and bind; only
  the build-time "unknown event" check is inert. Tracked for a follow-on.

## [0.13.0] — 2026-05-31

Track D round-2/3 — the integration codegen now emits the **full** integration
layer. Where 0.12.x stopped at the read side (provider module, adapter scaffold,
registry, typed views), 0.13.0 adds the **module assembly** (the write/run side —
RFC-0002) and reshapes the read body into the **`IncrementalRead` primitive**
(RFC-0003). After this release the author fills only the irreducible vendor seam:
the `enumerate` / `hydrate` / `toCanonical` read methods and any non-generic sink
write logic.

Core and the four surface packages (`codegen-{mail,calendar,transcript,crm}`)
**release together** — the surfaces carry the BREAKING port change below and
require the matching core (peer dep `^0.13.0`).

### BREAKING

- **Surface ports declare `changeSources`, not `sources`.** The four surface
  ports (`MailPort` / `CalendarPort` / `TranscriptPort` / `CrmPort`) now require
  `readonly changeSources: Record<string, IChangeSource<unknown>>` — the
  per-entity change sources the adapter *contributes*, keyed by entity name —
  instead of the old `readonly sources: IEntityChangeSourceRegistry`. The folded,
  entity-keyed registry (`<SURFACE>_ENTITY_SOURCES`) is now the **surface
  module's** concern: the surface aggregator folds every provider's
  `changeSources` into it, and entity-agnostic consumers read it at runtime. This
  drops a vestigial registry injection from the adapter (it was read by nothing
  and formed a latent DI cycle — RFC-0002 §3 E0), making the adapter
  standalone-importable. The four surface packages bump to **0.2.0**; their peer
  dep on `@pattern-stack/codegen` moves to **^0.13.0**. Conformance helpers
  (`assert<Surface>Adapter`) check `changeSources` membership accordingly.

### Added

- **Integration module assembly emission (RFC-0002).** Per `(surface, provider,
  entity-with-surface)`, codegen now emits the assembly that turns a registry of
  change sources into a runnable integration per entity:
  - `<surface>/modules/<provider>/<entity>-integration.module.ts` — `@generated`
    per-entity feature module binding `INTEGRATION_CHANGE_SOURCE`
    (= `adapter.changeSources['<entity>']`, Option A) + `INTEGRATION_SINK`, a
    local `ExecuteIntegrationUseCase`, and a uniquely-tokened handle
    (`<ENTITY>_INTEGRATION_USE_CASE__<PROVIDER>`) a trigger can grab.
  - `<surface>/sinks/<entity>.sink.ts` — emit-once **default sink** scaffold
    (`// <CODEGEN-SCAFFOLD-V1>`) over the entity's generated `Integrated`
    repository (`pattern: Integrated` only — hard-errors otherwise); author fills
    any non-generic `canonical ↔ local` mapping.
  - `<surface>/<surface>-integration.module.ts` — `@generated` aggregator over
    the per-entity modules.
  - `<surface>/<surface>-integration.tokens.ts` — `@generated` use-case tokens.
- **`IncrementalRead` read primitive (RFC-0003).** A universal read capability
  (`IncrementalRead<T, F>` / `RandomRead<T>` / `IncrementalReadBase` +
  `SourcedRecord` / `Ref` / `ReadMode` / `ReadRequest` / `mapConcurrent`) in
  `runtime/subsystems/integration/`, exported from
  `@pattern-stack/codegen/subsystems`. The base decomposes the read into
  `enumerate(mode, filter) → AsyncIterable<Ref>` (cheap delta/backfill walk) and
  `hydrate(ids) → Map<id, raw>` (batched fetch-by-id), and owns the orchestration
  (drain, **filter-before-hydrate**, bounded-concurrency hydrate, per-ref cursor
  emission, `listChanges` adaptation). Cursor divisibility is kind-keyed
  (`CURSOR_DIVISIBILITY` / `isDivisibleCursor`); atomic strategies (`historyId` /
  `syncToken`) withhold the per-ref cursor until a safe boundary so an
  interrupted backfill never persists an unresumable token.
- **Read-side scaffold reshape.** For interaction surfaces (mail / calendar /
  transcript), `generateAdapterScaffold` now emits each `changeSources` entry as
  an emit-once `IncrementalReadBase<Canonical<Entity>, ResolvedFilter[]>`
  subclass — the buffer-all/serial/run-final-cursor regression becomes
  structurally unwritable. CRM keeps its author-filled `changeSources` seam
  (field-reader model, no single canonical `T`).

## [0.12.2] — 2026-05-31

Track D consumer-CLI fix. The 0.12.0/0.12.1 generator was correct in the
hermetic D7 path but broke for real consumers driving it through the CLI. Two
schema/loader bugs plus a DX gap that masked the first. No swe-brain YAML change
is required — consumer YAML already wrote the keys in the natural place; the
schema is now corrected to match.

### Fixed

- **`entity.surface` / `entity.context` schema level.** `surface:` and
  `context:` were defined at the ROOT of `EntityDefinitionSchema` (sibling of
  `entity:`/`fields:`), but consumers naturally write them INSIDE the `entity:`
  block (next to `pattern:`/`name:`/`table:`). Because the `entity:` block is
  `.strict()`, those YAMLs were rejected with "Unrecognized key(s) in object:
  'surface' at 'entity'". The fields now live in `EntityConfigSchema` and are
  read as `entity.surface` / `entity.context`. Clean break — root-level
  placement no longer validates. Read sites updated:
  `collectEntitySurfaces` (`validate-providers.ts`), `collectEntitiesBySurface`
  (`adapter-emission-generator.ts`), the provider surface cross-check
  (`entity.ts`), and the clean-lite-ps output-subfolder consumer
  (`prompt-extension.js` `buildCleanLitePsLocals`).
- **Entity `--all` discovery no longer globs `definitions/providers/`.** With
  `entities_dir: definitions`, the recursive YAML walk pulled provider files
  into the entity loader, where they fail entity validation. Entity discovery
  (`findYamlFiles`, `loadEntities`, `listEntityYamls`) now excludes the
  configured providers dir (`paths.providers`, default `definitions/providers`).
  Provider files route only through `ProviderDefinitionSchema`.

### Changed

- **`entity new --dry-run` surfaces the Zod detail.** The failure path printed
  only "Validation failed for <file>"; it now emits the same per-issue Zod
  diagnostics as `entity validate`, so a misplaced key reports which key/level
  is wrong (the DX gap that hid the `entity.surface` rejection).

## [0.12.1] — 2026-05-31

Track D (provider/adapter integration codegen) discoverability fix. The 0.12.0
generator wiring is correct and shipped — provider + adapter emission runs as a
post-step of `codegen entity new` whenever `definitions/providers/*.yaml` exist
— but nothing in the CLI surfaced that, so consumers searched `--help` for a
`provider` / `integration` / `gen` command, found none, and mistook a working
feature for a publish gap. Docs-and-help only; no generator behavior changed.

### Changed

- **`codegen entity new --help`** now documents every post-generation step it
  runs (event / bridge / orchestration / **provider + adapter (Track D)**
  codegen), including Track D's trigger (`definitions/providers/*.yaml`), output
  paths (`<backendSrc>/integrations/{providers,}`), emit-once semantics, and an
  explicit note that there is no standalone `provider` / `integration` / `gen`
  command — Track D is driven entirely by re-running `entity new`.
- **`codegen entity` summary hints** now surface a Track D regen hint when the
  project has a providers directory — a discoverability path that does not
  require reading `entity new --help`.
- **Integration domain skill** (`protocols-and-ports.md`, `SKILL.md`) documents
  the Track D invocation, the skip-when-no-providers-dir behavior, and that the
  generated scaffold (not the `.d.ts`) is ground truth for adapter port shape.

## [0.12.0] — 2026-05-31

Integration codegen retarget (RFC-0001): a **provider/adapter/surface** model
for integration codegen, plus a **surface-package framework**. Additive over
0.11.0 — new declarative inputs and emitted artifacts; existing entity codegen
is unchanged. The one breaking item (the ADR-033.2 per-entity provider tuples)
has no consumers. Consumers adopt by adding `definitions/providers/*.yaml` and
regenerating. Ships alongside four independently-versioned **surface packages**
(`@pattern-stack/codegen-{crm,calendar,mail,transcript}`) at `0.1.1`. (Their
initial `0.1.0` release peer-depended on `@pattern-stack/codegen` `^0.11.0`,
which predates the `./subsystems` export they require; `0.1.1` corrects the peer
to `^0.12.0`. The peer source fix merged with 0.12.0 but the version bump was
missed — this completes it.)

### ⚠ BREAKING CHANGES

- **ADR-033.2 per-entity provider tuples removed.** The
  `<entity>-integration-source.providers.ts` emission (`<ENTITY>_PROVIDERS`
  const + `<Entity>Provider` type) is deleted. Its replacement is the
  surface-scoped, codegen-owned typed view at
  `src/integrations/<surface>/types.generated.ts` (`<Surface>Provider` /
  `<Surface>Entity` unions + a `(provider, entity)` validity map) — a single
  source of provider truth. ADR-033.2 is superseded by RFC-0001. No published
  consumers depend on the tuples.

### Added

- **Track C — surface-package framework (ADR-036).** First-class L2 *surface
  packages* shipping type-shaped ports + DI tokens + an L3 composing port per
  integration surface:
  - **L1** — `IEntityChangeSourceRegistry` (entity-keyed change-source
    resolver) + `MemoryEntityChangeSourceRegistry` + the
    `ENTITY_CHANGE_SOURCE_REGISTRY` token, in the integration subsystem;
    exported across the package boundary via `@pattern-stack/codegen/subsystems`.
  - **`@pattern-stack/codegen-crm`** — L2 CRM ports (`IFieldDefinitionReader`,
    `IPicklistReader`, `IAssociationReader`), the `CrmCapabilities` descriptor,
    and the L3 entity-agnostic **`CrmPort`** composing port + `assertCrmAdapter`
    conformance helper (on the `/testing` subpath).
  - **`@pattern-stack/codegen-{calendar,mail,transcript}`** — incremental-read
    interaction surfaces (`CalendarPort` / `MailPort` / `TranscriptPort`,
    canonical types, capability descriptors). Independently versioned (`0.1.1`).
- **Track D — provider/adapter integration codegen (RFC-0001).**
  - `definitions/providers/<provider>.yaml` — providers as first-class
    declarative artifacts (slug, auth strategy, client, surfaces); Zod schema +
    validator with a **pre-flight import-path check** (a missing
    strategy/client export fails `cdp gen`, not NestJS boot), surface
    cross-check, and slug-uniqueness.
  - Emits, per provider × surface: a `<provider>.provider.module.ts`, an
    **emit-once** `<provider>-<surface>.adapter.ts` scaffold (sentinel-guarded,
    author-owned after first emit), fully codegen-owned adapter modules +
    barrels, a per-surface registry (`<SURFACE>_ADAPTER_CONTRIBUTIONS` →
    `<SURFACE>_ENTITY_SOURCES`, folding into the L1 registry), and the
    `types.generated.ts` typed view.
  - Optional entity-YAML **`surface:`** field — the declarative input the
    provider/adapter emission groups entities by.
- **`context:` output-folder grouping (#403).** An optional top-level entity
  `context:` nests its generated module folder under that segment
  (`<modules>/<context>/<plural>/`); no context → flat (byte-identical to
  before).
- **Multi-package release.** `just publish` publishes the root plus every
  opted-in `packages/*` (those declaring `publishConfig.access: public`) at its
  own independent version, skipping versions already on npm.

## [0.11.0] — 2026-05-30

Vocabulary rename per **ADR-0005 (swe-brain `.ai-docs/decisions/ADR-0005-rename-sync-to-integration.md`)**:
the data-movement domain `sync` → `integration` (reserving "sync" for
ElectricSQL-style replication), the `Synced` entity family → `Integrated`, and
the authenticated vendor-link `IntegrationStore` → `ConnectionStore`. This is a
clean break — there are no compat shims or deprecated aliases; consumers
migrate by **regenerating** off the renamed substrate (codegen owns the
physical/structural names).

### ⚠ BREAKING CHANGES

- **Integration engine (`sync` → `integration`).**
  - `SyncModule` → `IntegrationModule` (`.forRoot({ backend, multiTenant? })`);
    `ExecuteSyncUseCase` → `ExecuteIntegrationUseCase`.
  - Tokens `SYNC_*` → `INTEGRATION_*` (cursor store, run recorder, field
    differ, change source, sink, multi-tenant flag, module options).
  - Protocols/ports/recorders/cursor-stores/errors `sync-*` → `integration-*`;
    `runtime/subsystems/sync/**` → `runtime/subsystems/integration/**`.
  - Tables `sync_runs` / `sync_run_items` / `sync_subscriptions` →
    `integration_runs` / `integration_run_items` / `integration_subscriptions`;
    cursor column `last_sync_at` → `last_integration_at`.
  - Entity-YAML config block `sync:` → `integration:` (incl. `sync.inbound` →
    `integration.inbound`); the per-entity `*-sync-source.module.ts` codegen
    output → `*-integration-source.module.ts`.
  - CLI: `codegen subsystem install sync` → `… install integration`; the
    `/sync` skill → `/integration`.
- **`Synced` entity family → `Integrated`.**
  - `SyncedEntityRepository` / `SyncedEntityService` → `IntegratedEntityRepository`
    / `IntegratedEntityService`; `SyncUpsertConfig` → `IntegrationUpsertConfig`;
    `syncUpsertOne`/`syncUpsert`/`syncConfig`/`SyncFkResolver` →
    `integrationUpsertOne`/`integrationUpsert`/`integrationConfig`/`IntegrationFkResolver`;
    `junction-sync-repository.ts` → `junction-integration-repository.ts`.
  - YAML `pattern: Synced` → `pattern: Integrated`.
- **Auth vendor-link `integration` → `connection`.**
  - `IntegrationStore` ports → `ConnectionStore`:
    `IIntegrationReader`/`IIntegrationTokenWriter`/`IIntegrationGrantSink` →
    `IConnection*`; `DecryptedIntegration` → `DecryptedConnection`;
    `IntegrationGrantInput`/`IntegrationTokenUpdate` → `Connection*`;
    `IntegrationBrokenError` → `ConnectionBrokenError`; DI tokens
    `AUTH_INTEGRATION_*` → `AUTH_CONNECTION_*`.
  - Engine FK `integration_subscriptions.integration_id` → `connection_id`
    (the column references the connected account/instance — a *connection*;
    the table name stays `integration_subscriptions`).
  - The `examples/auth-integrations` starter is fully renamed to the connection
    vocabulary: `connection.yaml` entity (table `connections`),
    `ConnectionsService`, `ConnectionsAuthModule`, `Connection*Adapter`,
    vendored under `<modules>/connections/`. The `auth-integrations` subsystem
    **install command** keeps its name.

### Preserved (NOT renamed)

- The CLI imperative **verb** `sync` in app-level event names
  (`crm_sync_started`, `webhook_outbound_contact_sync`).
- ElectricSQL `frontend.sync` collection config (replication sense).

### Migration

No shims. Re-vendor the runtime (`codegen update`) and **regenerate** entities/
subsystems off the renamed names; update app code that references the renamed
symbols/tokens/tables/config keys. See ADR-0005 (swe-brain `.ai-docs/decisions/ADR-0005-rename-sync-to-integration.md`).

## [0.10.1] — 2026-05-28

Dogfood fixes found wiring `@pattern-stack/codegen@0.10.0` into a second
consumer (swe-brain): the type-check blockers that forced consumers to exclude
the vendored subsystem tree from `tsc` are gone. A drizzle-only install now
type-checks its full tree (`src/shared/subsystems/**` included) with no
`ioredis`/`bullmq` peer deps.

### Fixed

- **`fix(subsystems)` — detection + barrel emission key on `<name>.module.ts`
  (#4, #2).** Installing one subsystem can vendor *protocol stubs* of another
  (e.g. events vendors `bridge/bridge.protocol.ts`); detection used to report
  those stub-only dirs as `installed` and the barrel emitted a phantom
  `BridgeModule` import for a module that was never installed (TS2307).
  Detection now requires the module file; `subsystem list` reports `incomplete`
  for stub-only dirs; the barrel skips them.
- **`fix(events)` — drizzle backend type-checks against its paired schema
  (#3).** `event-bus.drizzle-backend.ts` read a `tier` column the schema never
  emitted and `tenant_id` columns only present under multi-tenancy. `tier` is
  now always emitted; `tenant_id` access is gated behind `multiTenant`, so the
  backend type-checks under any configuration.
- **`fix(subsystems)` — installs no longer vendor unselected backends (#6).** A
  `--backend drizzle` install previously vendored the Redis and BullMQ backend
  sources too, dragging `ioredis`/`bullmq` (uninstalled optional peers) into the
  consumer's type-check. The copy filter now prunes `*.redis-backend.ts` /
  `*.bullmq-backend.ts` for non-matching installs; modules lazy-load the chosen
  backend via a non-literal dynamic import; backend-specific classes are no
  longer re-exported from the public barrels; `bullmq.config.ts` is kept on
  every install (peer-dep-free) for its static token references; the BullMQ
  backend is `noImplicitAny`-clean.
- **`fix(barrel)` — empty-composer output emits the `DynamicModule` import.** A
  generated `subsystems.ts` with no composer calls referenced `DynamicModule`
  without importing it (latent since BULLMQ-1, surfaced by the stricter
  detection above).

### Added

- **`feat(cli)` — `codegen subsystem remove` (#5, #7).** Real implementation:
  deletes the vendored subsystem dir, regenerates the barrel, git-safety gated
  with `--force`, and `--yes`/`-y` parity with `install`. Prints the manual
  follow-ups it deliberately does *not* perform (config-block strip,
  `forRoot` un-registration).
- **`test(smoke)` — `run-smoke-subsystems.ts`.** Exercises an events + jobs +
  bridge drizzle install with a full-tree `tsc` (no subsystem excludes) + a
  programmatic NestJS boot that validates the bridge reserved-pool dependency
  graph. Wired into `just test-all`.

## [0.10.0] — 2026-05-27

### Added

- **`feat(cli)` — consumer skill distribution (ADR-035).** A curated
  `consumer-skills/` set (a `codegen` router plus `entities`, `subsystems`,
  `jobs`, `events`, `bridge`, `sync`) is vendored into a consumer's
  `.claude/skills/` via a new `skills` noun (`codegen skills install` / `list`),
  and by `codegen init` by default (`--no-skills` to opt out). Authored fresh
  for a consumer audience; shipped in the npm `files` array.
- **`feat(cli)` — `codegen update`.** Re-syncs the vendored runtime closure,
  installed subsystems' runtime, and consumer skills to the installed package
  version after a bump. Drift-aware, git-clean gated (`--force`), `--dry-run`;
  never touches consumer-owned files (config, `app.module.ts`, barrels).
- **`feat(parser)` — recursive YAML discovery.** Entity / relationship /
  junction / event discovery routes through a single `findYamlFiles` helper;
  domain-folder layouts (`entities/crm/account.yaml`) are first-class.

### Changed

- **Docs split.** `CONSUMER-SETUP.md` became a hub; the per-subsystem deep dives
  moved to `docs/consumer/{events,bridge,sync,auth,openapi}.md` (progressive
  disclosure), with jobs-API drift (`JobsModule` → `JobsDomainModule` +
  `JobWorkerModule`, `JobHandlerBase`, `concurrency: { key }`) corrected.

## [0.9.0] — 2026-05-25

Bundles four merged PRs (none carried a version bump): the BullMQ backend and
observability list-reads (features), plus two consumer-facing type-check fixes.

### Added

- **`feat(jobs)` — BullMQ `IJobOrchestrator` backend (BULLMQ-1, #385).** A second
  orchestrator backend behind the existing core contract, plus the Phase-1 prep:
  the bridge reserved-pool guard is revived (`JOB_WORKER_MODULE_OPTIONS` export),
  a `JobWorkerModule.forRoot({ allPools })` option, and a bridge/events-aware
  standalone `worker.ts` template.
- **`feat(observability)` — row-level list reads in the combiner (OBS-LIST-1,
  #384).** `listJobRuns` / `listEvents` / `getCorrelationTimeline` on the
  observability combiner + composing ports (drizzle + memory).

### Fixed

- **`fix(subsystems)` — type-check under a `multi_tenant:false`, no-events
  consumer (#383).** The sync schema template now always emits `tenant_id`
  (the runtime sync code references it unconditionally; `SYNC_MULTI_TENANT`
  gates enforcement, not the column), and the event-codegen generator falls back
  to `EventOfType<T> = DomainEvent` (not `never`) when no events are declared, so
  the bridge `EventFlowService` type-checks. Surfaced by a downstream consumer's
  CI; codegen-patterns' own suite never hit it.
- **`fix(clean-lite-ps)` — create-DTO nullable fields are also optional (#382).**
  `zodChainForCreate` applied `.nullable()` / `.optional()` mutually
  exclusively, so a nullable, non-required field stayed a required key.

## [0.8.1] — 2026-05-25

Closes the loop on ambient tenant scoping (0.8.0): adds the **RequesterContext
boundary** that turns an authenticated request into ambient scope, so scoping
actually engages over HTTP — including Swagger's "Authorize" bearer flow. See
ADR-0002 (`ai-docs/adrs/0002-requester-context-boundary.md`).

### Added

- **`feat(auth)` — `RequesterContextMiddleware` + `installRequesterContext`.** New
  `runtime/subsystems/auth/middleware/requester-context.ts`. The Express-style
  middleware resolves the requester via the consumer's `IUserContext` and runs the
  rest of the request inside `withRequester(...)`, so every downstream repository
  read/write is auto-scoped (ADR-0001) with no threaded `userId`. ALS-correct
  (middleware, not interceptor). `installRequesterContext(app)` is the one-liner
  for `main.ts`: resolves `AUTH_USER_CONTEXT` from the root container
  (`app.get(token, { strict: false })`), no-ops with a warning when unbound.
  Exported from the auth barrel. Verified over real HTTP — two concurrent requests
  with different bearer tokens each observe their own scope; an unauthenticated
  request observes none (`requester-context.http.spec.ts`).
- **`feat(auth)` — optional `IUserContext.resolveRequester(req)`.** Supplies the
  full `org`/`superuser` `RequesterContext` (org member list resolved at the
  boundary). Backward compatible: when absent, the boundary derives plain `'user'`
  scope from `getCurrentUserId`.

### Changed

- **`feat(scaffold)` — generated `main.ts` persists Swagger auth.**
  `SwaggerModule.setup(...)` now passes `{ swaggerOptions: { persistAuthorization:
  true } }`, so the "Authorize" bearer token survives reloads and keeps flowing as
  the `Authorization` header the boundary reads. The generated `main.ts` also
  carries a commented `installRequesterContext(app)` hint (not a static import — so
  scaffolds without the auth subsystem still compile).

### Notes

- Wiring is opt-in: add `installRequesterContext(app)` to your bootstrap after
  `NestFactory.create`. Auto-patching it in at `subsystem install auth` time (like
  the Swagger block) is a deferred follow-up (ADR-0002). A tRPC-side boundary and
  junction-repo scoping remain deferred.

## [0.8.0] — 2026-05-25

Adds **ambient tenant scoping** to `BaseRepository`: user-owned repos filter every
read/write by the requester automatically, instead of relying on hand-threaded
`userId` parameters. Ports the proven `dealbrain` `RequesterContext` pattern into
the codegen substrate. See ADR-0001 (`ai-docs/adrs/0001-ambient-tenant-scoping.md`).

### Added

- **`feat(runtime)` — `tenant-context.ts` ambient scope primitive.** New
  `runtime/base-classes/tenant-context.ts`: an `AsyncLocalStorage`-backed
  `RequesterContext { userId, organizationId, scope?, orgUserIds? }` with
  `withRequester(ctx, fn)` (set at a boundary), `requireRequester()` /
  `tryGetRequester()` (read inside repos), and `withUserScope` / `withOrgScope` /
  `withSuperuserScope` helpers. Scope model (`'user' | 'org' | 'superuser'`)
  copied verbatim from `dealbrain` `packages/integrations/src/framework`.
  Vendored into consumers via `init-scaffold` and exported from the base-classes
  barrel.
- **`feat(runtime)` — `BaseRepository.scopePredicate()` + `scopeAnd()`.** When a
  repo declares `behaviors.userTracking` (i.e. the entity has the `user_tracking`
  behavior) and an ambient `RequesterContext` is active, `findById`, `findByIds`,
  `list`, `count`, `update`, and `delete` automatically filter by `user_id`:
  `= ctx.userId` (`user`), `IN ctx.orgUserIds` (`org`; empty ⇒ matches nothing),
  or unfiltered (`superuser`). **No new per-entity config knob** — it rides the
  existing (previously dormant) `userTracking` flag. No template changes.
- **Unit coverage** — `base-repository.spec.ts` gains a scoping suite that renders
  real Drizzle SQL (via `QueryBuilder`) to assert the emitted `WHERE` per scope,
  gating (off when `userTracking` false / no context), strict-mode throw, and the
  combined soft-delete + scope + leaf predicate.

### Changed

- **`scopeEnforcement` (lenient default).** With no ambient context active, a
  `userTracking` repo is **not** scoped — adopting ambient scoping is additive,
  and isolation engages only once a boundary installs `withRequester(...)`. Set
  `protected readonly scopeEnforcement = 'strict'` on a repo or family base to
  make a missing boundary throw (fail-loud). Validated against
  `dealbrain-integrations` (no `userTracking` repos today): typecheck + 737 tests
  green, behavior unchanged.

### Fixed

- **`fix(runtime)` — soft-delete guard no longer dropped on `findById` /
  `list({where})` / bespoke query methods.** Drizzle's `.where()` *overrides* a
  prior `.where()` on a `$dynamic()` query, so the soft-delete `isNull` filter
  that `baseQuery()` added was being silently discarded whenever a leaf method
  chained its own `.where()` — only no-arg `list()` and `count()` actually
  excluded soft-deleted rows. `baseQuery(extra?)` now folds soft-delete + scope +
  the leaf predicate into a single AND-joined `WHERE`.
  - **Migration:** on `soft_delete` entities, `findById(id)` and `list({ where })`
    now correctly **exclude** soft-deleted rows (previously returned them). Code
    that relied on the old behavior to read a soft-deleted row must query
    `deletedAt` explicitly.

## [0.7.8] — 2026-05-25

Fixes a NestJS DI-resolution bug in cross-entity module wiring. A generated service that injects a sibling entity's **repository** — junction `.list()` composition (CGP-60), EAV value→definition resolution (`eav_value_table`) — failed at runtime because the sibling module exported only its **service**, never its repository (ADR-002). The code typechecked (`tsc` can't see DI wiring), so it shipped and only surfaced on a consumer's first `NestFactory` boot (dealbrain-integrations).

### Fixed

- **`fix(templates)` — entity modules export their repository.** `templates/entity/new/clean-lite-ps/module.ejs.t` now emits `exports: [<Service>, <Repository>]`. Cross-module consumers already imported the sibling *module*; the repository was just never exported, so DI couldn't resolve it. Exporting it means the consumer injects the **home-module instance** — the only place the repo's own dependencies are wired (e.g. an EAV entity's repository injects `FieldValueService` for the sync dual-write transaction, so it can only be constructed in its home module; local-providing it elsewhere can't satisfy that dep). ADR-002 revised: the repository is part of a module's public surface; use-case internals stay unexported.

### Added

- **DI-resolution smoke gate (`test/smoke/verify-boot.ts`).** Boots the generated `AppModule` via `NestFactory.create` + `app.init()` — instantiating every provider across every module — wired into the junction smoke (`run-smoke-junction.ts` step 10). Closes the gap that let the bug ship: the junction + EAV pipelines were gated only by `tsc` + grep, neither of which exercises runtime DI. Verified: reverting the repository export passes `tsc` but fails the boot gate with the exact `UnknownDependencies` error.

## [0.7.3] — 2026-05-23

Auto-emits `<generated>/subsystems.ts` — a `SUBSYSTEM_MODULES` barrel of `forRoot()` calls for every installed subsystem. Removes the "did I forget to wire `SyncModule`?" class of silent-failure bug when a subsystem is declared in `subsystems.install` but never imported into AppModule.

### Added

- **`feat(codegen)` — subsystem composition barrel.** New `src/cli/shared/subsystem-barrel-generator.ts` emits `<generated>/subsystems.ts`:

  ```ts
  // AUTO-GENERATED — wire into AppModule once:
  // @Module({ imports: [DatabaseModule, ...SUBSYSTEM_MODULES, ...GENERATED_MODULES] })
  import type { DynamicModule } from '@nestjs/common';
  import { EventsModule } from '../shared/subsystems/events/events.module';
  import { JobsDomainModule } from '../shared/subsystems/jobs/jobs-domain.module';
  import { JobWorkerModule } from '../shared/subsystems/jobs/job-worker.module';
  import { BridgeModule } from '../shared/subsystems/bridge/bridge.module';
  import { SyncModule } from '../shared/subsystems/sync/sync.module';

  export const SUBSYSTEM_MODULES: DynamicModule[] = [
    EventsModule.forRoot({ backend: 'drizzle', multiTenant: false }),
    JobsDomainModule.forRoot({ backend: 'drizzle', multiTenant: false }),
    JobWorkerModule.forRoot({ mode: 'embedded' }),
    BridgeModule.forRoot({ backend: 'drizzle', multiTenant: false }),
    SyncModule.forRoot({ backend: 'drizzle', multiTenant: false }),
  ];
  ```

  Composer coverage: `events`, `jobs` (+ `JobWorkerModule` when `worker_mode: 'embedded'`), `bridge`, `sync`. `auth`, `auth-integrations`, `observability` are out of scope (their `forRoot` shapes take init-time arguments — encryption keys, IUserContext adapters — that can't be synthesized from config alone; hand-wire those).

- **Auto-regen wiring.** `codegen entity new --all` and `codegen subsystem install <name>` now call `regenerateSubsystemBarrel({ ctx, generatedDir })` after their existing barrel work. Soft-fail (warn-only) to match the entity-barrel pattern.

- **8 unit tests** under `src/__tests__/cli/subsystem-barrel-generator.test.ts` covering empty install set, single-subsystem composition, full-minimum-set ordering, `worker_mode: 'embedded'` toggle, `multi_tenant` propagation, unsupported subsystem reporting via `skipped`, default options when config block is missing.

### Migration

Greenfield: re-run `codegen entity new --all` and add `...SUBSYSTEM_MODULES` to your AppModule's `imports`. The barrel is opt-in — existing AppModules continue to work without it.

The 4 subsystems composer currently supports are the ones consumers actually wire today; widening the composer set is straightforward — see `COMPOSERS` map in `subsystem-barrel-generator.ts`.

### Known interaction

If your project uses `SyncModule.forRoot({ backend: 'drizzle', multiTenant: false })`, tsc will surface pre-existing `tenantId`-reference errors in `sync-cursor-store.drizzle-backend.ts` / `sync-run-recorder.drizzle-backend.ts` when the subsystem barrel transitively pulls those files into typecheck scope. This is an unrelated upstream issue (multi-tenancy-off + drizzle backend wasn't typecheck-clean before this PR either; consumers worked around it by excluding `src/shared/subsystems` from tsconfig). Either keep the exclude in place, or set `multi_tenant: true` in your sync config to add the `tenant_id` column the backends reference.

## [0.7.2] — 2026-05-23

Hotfix for the sync subsystem differ — `external_id_tracking` columns (added by the `external_id_tracking` behavior) were always emitting field diffs even when they hadn't changed in vendor input, producing churn. (Shipped on `main` between 0.7.1 and the junction-import dedupe; previously unreleased.)

## [0.7.1] — 2026-05-23

Hotfix for the junction emit pipeline (CGP-60, shipped in 0.7.0). When a parent entity participated in **multiple junctions** (e.g. `contact` appearing as the right side of both `account_contact` and `opportunity_contact`), each junction's `_inject-parent-{service,module}-import-clp-{left,right}.ejs.t` template emitted the same shared `import { forwardRef } from '@nestjs/common';` line independently — producing duplicate-import TS errors (TS2300 `Duplicate identifier 'forwardRef'`). The same loop also re-emitted the counterparty entity type import (`import type { Account } from '../accounts/account.entity'`), which collided with the parent's own `belongs_to` import emitted by `service.ejs.t`.

### Fixed

- **`fix(codegen)` — junction import dedupe across multi-junction parents.** Split each of the 4 existing junction inject templates (`_inject-parent-{service,module}-import-clp-{left,right}.ejs.t`) into 3 narrower inject templates with broader `skip_if` guards:
  - `_inject-parent-{service,module}-forwardref-clp-{left,right}.ejs.t` — emits only `import { forwardRef }`, gated by `skip_if: "import { forwardRef"` (matches actual import line, not body usage)
  - `_inject-parent-service-counterparty-clp-{left,right}.ejs.t` — emits the counterparty entity type import, gated by `skip_if: "from '<counterparty-path>'"` (matches any prior import from that path, including the parent's `belongs_to` import)
  - Existing `_inject-parent-{service,module}-import-clp-{left,right}.ejs.t` — narrowed to just the junction-specific imports (already had a per-junction `skip_if`)
- Updated junction snapshot tests (`test/junction/__snapshots__/opportunity-contact.test.ts.snap`, `opportunity-activity.test.ts.snap`) to reflect the new split-block layout.

### Migration note

No breaking change for the emitted code semantics — the output is functionally identical for single-junction projects, and now actually compiles for multi-junction projects. Greenfield re-emit is safe; existing emitted files re-emit cleanly via `--force`.

## [0.6.8] — 2026-04-28

Hotfix for enum codegen in the `clean-lite-ps` template pipeline. Surfaced during integration-patterns Wave 0b: enum-typed YAML fields emitted a Drizzle `text()` column instead of a `pgEnum`, so `InferSelectModel` resolved to `string` instead of the literal-union type and forced hand-casts in consumer code (e.g. `as DecryptedIntegrationRow['status']`).

### Fixed

- **`fix(codegen)` — clean-lite-ps enum emission.** `templates/entity/new/clean-lite-ps/prompt-extension.js` now produces `pgEnum` declarations + column references for any field with `choices` (or `type: enum`), matching the backend pipeline at `templates/entity/new/backend/database/schema.ejs.t:66-104`. Generated entity files now contain `export const xEnum = pgEnum('x', [...])` ahead of the `pgTable(...)` block and reference `xEnum('x').notNull()` inside the column map. `pgEnum` is added to the `drizzle-orm/pg-core` import list automatically when any enum field is present. The emitted `InferSelectModel` type now narrows to the literal union — consumers can drop `as Row['status']` casts. New unit coverage: `src/__tests__/clean-lite-ps/entity-enum-template.test.ts`.

### Migration note

Not a breaking change for the emitted code shape (the field's TypeScript type narrows — a strict superset of what consumer code can do). Existing Postgres databases generated against 0.6.7 or earlier will need a one-time `CREATE TYPE … AS ENUM (...)` + `ALTER TABLE … ALTER COLUMN x TYPE x_enum USING x::x_enum;` migration, since the column was previously `text`. Greenfield projects, or anyone regenerating before the first migration runs, are unaffected.

## [0.6.7] — 2026-04-28

Hotfix bundle for `cdp subsystem install auth-integrations`. 0.6.5 / 0.6.6 shipped the auth-integrations starter and install template, but every downstream consumer ran into four blockers on a fresh install. None of them surfaced from the source-checkout smoke (the install code resolves examples/ via the package root, which exists in dev) — they only exposed themselves through `npm install + bunx cdp subsystem install auth-integrations` against the published tarball. Bundles a fifth fix that unifies the integrations folder layout. Surfaced by integration-patterns Wave 0b.

### Changed

- **BREAKING — `fix(cli)` #303 (fix #5)** — `cdp subsystem install auth-integrations` now vendors the starter under `<paths.backend_src>/modules/integrations/` (override via `paths.modules_dir`), next to the codegen-emitted `integration` entity module. Previously: `<paths.backend_src>/shared/integrations/`. The starter's runtime tree is now organized under `adapters/`, `facade/`, and `oauth/use-cases/` subfolders to avoid collision with codegen output, and `IntegrationsAuthModule` lives at the integrations folder root. Relative imports inside the vendored files (and the bare-package auth import rewriter, fix #3) target the new layout. Detection (`detectInstalledSubsystems`) checks the new vendor target first and falls back to the legacy shared/integrations location for any pre-0.6.7 install. Pre-1.0; the only downstream consumer of 0.6.5/0.6.6 is integration-patterns Wave 0b (unmerged).

### Fixed

- **P0 — `fix(packaging)` #303** — added `examples/auth-integrations/**` to `package.json:files`. The 0.6.6 tarball did not include the starter source; `cdp subsystem install auth-integrations` therefore failed to find `node_modules/@pattern-stack/codegen/examples/auth-integrations/` and aborted the vendor copy. Narrowed to the auth-integrations subtree only — internal `examples/` (eav etc.) stay out of the published artifact. Prevention: `src/__tests__/templates/auth-integrations-files-coverage.test.ts` walks every file under `examples/auth-integrations/` and asserts it matches a `files` pattern.
- **`fix(cli)` #303** — `cdp subsystem install auth-integrations` no longer drops `integration.yaml` at the wrong path. The scaffold-locals resolver was reading `paths.definitions` (a key that doesn't exist in the schema); switched to `paths.entities` with a fallback to legacy `paths.entities_dir`, matching the resolution order in `Context.entitiesDir` and `cdp project init`. Default location (`<cwd>/definitions/entities/integration.yaml`) is unchanged.
- **`fix(cli)` #303** — vendored adapters under `<sharedRoot>/integrations/` no longer carry bare-package imports `from '@pattern-stack/codegen/runtime/subsystems/auth'`. Those imports both fail `tsc --noEmit` (the package's `exports` map points at compiled `dist/runtime/*` files, not deep subpaths) AND would inject against the publisher's compiled token Symbols rather than the consumer's vendored auth subsystem (duplicate-DI hazard). The install logic now rewrites every such specifier to a relative path resolving against `<subsystemsRoot>/auth` at copy time.
- **`fix(examples)` #303** — `IntegrationsAuthModule` is now `@Global()`. `AuthController` lives inside `AuthModule`'s injector and resolves the `AUTH_INTEGRATION_*` providers exposed by `IntegrationsAuthModule`; without `@Global()`, Nest fails to boot. Same root cause as the auth-bindings module pattern in integration-patterns PR #93.

## [0.6.6] — 2026-04-27

Bundled cleanup PR for the auth subsystem surfaced during integration-patterns review. Pre-1.0, so two breaking renames are taken without compatibility shims.

### Changed

- **BREAKING — env var rename.** `TOKEN_ENCRYPTION_KEY` → `INTEGRATION_TOKEN_ENCRYPTION_KEY`. The auth subsystem only encrypts integration tokens; the scoped name is clearer about what the key protects and avoids colliding with other token-encryption keys a consumer might own. Read site (`runtime/subsystems/auth/backends/encryption-key/env.ts`), install template (`templates/subsystem/auth/env-config.ejs.t` + idempotency `skip_if`), CLI scaffold helpers, tests, and docs all moved together. Consumers running 0.6.5 must rename the env var and the `skip_if` line in their generated `.env.config`.
- **BREAKING — interface rename.** `ProviderStrategy` → `IProviderStrategy` to match the rest of the auth port naming (`IIntegrationReader`, `IUserContext`, `IOAuthStateStore`, `IEncryptionKey`). Convention documented at the top of `runtime/subsystems/auth/protocols/provider-strategy.ts`: `I*` for behavioral ports, no prefix for data DTOs / template-method abstract classes. `ProviderStrategyRegistry` (a `ReadonlyMap` value-shape) keeps its name.
- **OSS-hygiene scrub.** Removed or generalized references to the upstream extraction-source consumer across `runtime/`, `examples/`, and user-facing docs. ADRs and RFCs that document decision history retain their references intentionally.



Auth subsystem reaches consumers. `runtime/subsystems/auth/`, the `auth-integrations` starter, and the `cdp subsystem install auth` + `auth-integrations` templates were all merged on `main` (PRs #289, #290, #292, #293, #294, #295) but the published artifact was still pinned at `0.6.4`. This release ships them.

### Added

- **`feat(auth)` #289** — provider-agnostic `AuthController` mounting `GET /auth/:provider/connect` and `GET /auth/:provider/callback`, plus the `IUserContext` / `IOAuthStateStore` / `IIntegrationGrantSink` ports and memory + drizzle state-store backends. `OAuth2RefreshStrategy` extracted as a template-method base class. See `runtime/subsystems/auth/`.
- **`feat(examples)` #290** — `examples/auth-integrations/` starter: canonical `integration.yaml` entity + adapters that satisfy the three `AUTH_INTEGRATION_*` ports + `IntegrationsService` facade.
- **`feat(cdp)` #293** — `cdp subsystem install auth` and `cdp subsystem install auth-integrations` templates. The auth template emits `auth_oauth_state` drizzle schema, appends `TOKEN_ENCRYPTION_KEY` + `AUTH_REDIRECT_URI_BASE` to `.env.config`, and drops a TODO into `app.module.ts`. `auth-integrations` vendors the starter under `apps/api/src/shared/integrations/`.

## [0.6.4] — 2026-04-27

Two consumer-DX fixes surfaced by a fresh `cdp project init` run.

### Fixed

- **`fix(init)` #277** — typed the empty `GENERATED_MODULES` barrel emitted by `cdp project init`. The scaffold previously emitted `export const GENERATED_MODULES: unknown[] = []`, which fails `tsc --noEmit` against the scaffolded `app.module.ts` (`...GENERATED_MODULES` spread doesn't satisfy NestJS's `imports:` type) on day one of any new consumer project. Now typed as `Array<Type | DynamicModule | Promise<DynamicModule> | ForwardReference>`. Entity-populated barrels remain unaffected — class refs already satisfy `Type`.

### Changed

- **`fix(bin)` #277** — added `codegen` as the primary bin name in `package.json`. The previous bin name `cdp` collides with an unrelated published npm package, so `bunx cdp ...` (without a local install) silently fetches and runs the wrong package. The CLI banner, README, and downstream docs all already refer to the binary as `codegen`. `cdp` is preserved as an alias for backwards compatibility.

## [0.6.3] — 2026-04-26

### Fixed

- **`fix(publish)`** — remove stray `"private": true` field introduced incidentally in `0.6.2` (PR #273). `0.6.2` could not be published to npm (`EPRIVATE` error from `npm publish`). `0.6.3` is functionally identical to `0.6.2` plus the manifest fix.

## [0.6.2] — 2026-04-26

Critical hotfix for #272 + #269. `0.6.1` shipped with a tarball-only failure mode: `cdp entity` died with `Unknown Syntax Error: Extraneous positional argument ("entity")` because the entity noun silently failed to register. The actual cause was hidden by a bare `try { ... } catch {}` in `loadNouns()` swallowing the import error.

### Fixed

- **`fix(release)` #272** — root cause: `typescript` was declared in `devDependencies` but `import ts from 'typescript'` runs at module init from `src/cli/shared/bridge-registry-generator.ts` and `src/cli/commands/events.ts`. tsup externalizes `dependencies` / `peerDependencies` only — devDeps get inlined into `dist/src/cli/index.js`. The CJS `typescript` package then triggers `Dynamic require of "fs" is not supported` when its body runs inside the ESM bundle, killing the entity-noun import. The repo's source-checkout smoke (`just test-smoke`) doesn't catch this because it runs against `src/`, not the bundled tarball, where `typescript` resolves through Node's normal module loader. Fix: move `typescript` to `dependencies`. ts-morph already depended on it transitively; this just makes the direct import path correct.
- **`fix(cli)` #269** — `loadNouns()`'s per-noun `try { ... } catch {}` blocks silently dropped any noun whose import failed, so #272 surfaced as a cryptic "extraneous argument" error from clipanion instead of the real `Dynamic require of "fs"` ImportError. Replaced the dynamic-import + try/catch loader with static top-of-file imports and a flat `nouns` array. Static imports fail loudly at module-init with the real error; there is nothing left to catch. The defensive try/catch was a phase-transition artefact (intent: "skip unimplemented nouns") with no remaining purpose — every noun is now implemented and required.

### Prevention

The post-publish smoke (#190 / PR #271) catches this regression class: it packs the tarball, installs into a fresh tmp project, and exercises `cdp entity new --all` end-to-end. Once that lands on `main`, any future devDep-vs-bundle drift will fail CI on the publish path rather than on first npm-install by a downstream consumer.

## [0.6.1] — 2026-04-26

Critical hotfix for #266. `0.6.0` shipped with a broken `entity new` command for every npm consumer: `templates/entity/new/prompt.js` and `templates/entity/new/clean-lite-ps/prompt-extension.js` import runtime helpers from `../../../src/config/*.mjs` and `../../../src/patterns/registry.js`, but the `package.json:files` manifest excluded `src/`. Every published-tarball invocation died with `ResolveMessage: Cannot find module '../../../src/config/paths.mjs'`. The repo's smoke + baseline tests didn't catch this because they run from the source checkout, where the relative paths resolve directly.

### Fixed

- **`fix(release)` #266** — extend `package.json:files` with the narrow set of `src/` paths that templates reach for at runtime: `src/config/*.mjs`, `src/schema/naming-config.schema.mjs`, `src/patterns/registry.ts`, `src/patterns/pattern-definition.ts`, `src/patterns/library/*.ts`. Narrow paths (not a broad `src/` entry) so test files and CLI source stay out of the tarball. Verified by `npm pack && npm install ./pack.tgz && entity new` against a real fixture entity — generation now succeeds end-to-end.

### Added

- **Prevention test** at `src/__tests__/templates/files-manifest-coverage.test.ts`: statically scans every `templates/**/*.{js,mjs,cjs}` for relative imports that escape the `templates/` tree, resolves each against the source layout (with `.js → .ts` rewrite for Bun TS-aware ESM), and asserts the resolved path matches at least one entry in `package.json:files`. Fails CI when a future template adds a cross-package import without updating the manifest. Closes the hole identified in #190 (post-publish smoke proposal).

## [0.6.0] — 2026-04-26

Sync subsystem Phase 2: configurable change sources land. Detection mode is now declarative — entity YAML carries a `detection:` block parsed into a typed `DetectionConfig`, and codegen emits a per-entity Map factory module that wires consumer-supplied adapter callbacks to the right primitive. Plus audit-tier event classification (epic #242 phases 1–4).

### Added — sync configurable change sources (epic #226 / ADR-033)

- **`feat(sync)` #234 (#226-1)** — `DetectionConfigSchema` (Zod) at `runtime/subsystems/sync/detection-config.schema.ts`: discriminated union over `mode: 'poll' | 'webhook'`; flat-AND `ResolvedFilter` triples (`eq | neq | in | nin | gt | gte | lt | lte`); `CursorStrategy` tagged union (`systemModstamp | replayId | timestamp | eventId`); `poll.provenance: 'cdc'` knob for Stripe-style cursor-based event endpoints. Single source of truth for filter/mapping/cursor shape across the subsystem. ADR-033 locked. (`fced3e0`)
- **`feat(sync)` #237 (#226-3)** — `PollChangeSource<T>` poll-mode primitive parameterized by parsed `DetectionConfig` + `PollFetchCallback<T>`. Owns filter resolution, field-mapping → `externalId`, middleware composition, `Change<T>.source` provenance. (`2ba968e`)
- **`feat(sync)` #238 (#226-4)** — `WebhookChangeSource<T>` webhook-mode primitive: stamps `Change<T>.source = 'webhook'`, populates `dedupKey` from `webhook.eventIdField`. Passive iterator (does not drive the orchestrator). Inbound staging schema stays consumer-owned per ADR-002 §Phase 4. (`86f252b`)
- **`feat(sync)` #239 (#226-5)** — `createLoopbackMiddleware(store)` factory: loopback fingerprint suppression now ships as a stock `ChangeMiddleware<T>` consumers compose into a primitive's middleware chain. Orchestrator's `@Optional() SYNC_LOOPBACK_FINGERPRINT_STORE` branch deleted. (`f099269`)
- **`feat(schema)` #236 (#226-6)** — entity-YAML `detection:` block validated against `DetectionConfigSchema` at `pts codegen entity validate`. (`7fb27d9`)

### Added — provider-keyed detection (RFC #241 / ADR-033.1 + ADR-033.2)

- **`feat(schema)` #255 (ADR-033.1 a)** — `detection: z.record(z.string(), DetectionConfigSchema)`. Provider name is structure (the YAML key), not a new schema field. Within-file `superRefine` cross-checks every `detection:` key exists under `sync.providers:`. Multi-provider entities (HubSpot + Salesforce on the same canonical entity) are now first-class. (`d58d0e3`)
- **`feat(sync)` #256 (ADR-033.1 b)** — `buildChangeSource()` runtime factory: switches on `cfg.mode` to instantiate `PollChangeSource<T>` or `WebhookChangeSource<T>`, threads middlewares. Hides per-mode option-bag asymmetry (`adapter` vs `queue`) behind a single `fetch` callback parameter. Barrel-exported. (`5485922`)
- **`feat(codegen)` #259 (ADR-033.1 c + ADR-033.2)** — per-entity `<entity>-sync-source.module.ts` factory module: emits `<ENTITY>_DETECTION_CONFIGS` (private const) + `<ENTITY>_POLL_FETCH_REGISTRY` (consumer fills) + `<ENTITY>_CHANGE_SOURCES: ReadonlyMap<string, IChangeSource<T>>` (factory output). One module per entity regardless of provider count; no per-provider symbols. Also emits sibling `<entity>-sync-source.providers.ts` with `as const` tuple + `<EntityName>Provider` literal-union type for compile-time consumer registry checks. Drops `isCleanArchitecture` gate so the template emits in `clean-lite-ps` too. (`43a30ae`)
- **ADRs locked** (PR #249): `docs/adrs/ADR-033.1-provider-keyed-detection.md` (Accepted), `docs/adrs/ADR-033.2-typed-provider-artifacts.md` (Accepted), `docs/adrs/ADR-034-provider-registry.md` (Draft — placeholder for project-wide provider registry; tightens 033.1 validation when consumed). (`dfa90cd`)

### Added — audit-tier event classification (epic #242 phases 1–4)

- **`feat(events)` #219** — `tier` as a first-class event classification (`audit | domain | analytics`); foundation for downstream routing decisions. (`ad648df`)
- **`feat(events)` #258 (#244)** — `tier` column on event tables + CHECK constraint + Zod lock. Schema-level enforcement that every published event carries an explicit tier. (`14740b1`)
- **`feat(events)` #262 (#245)** — codegen emits `tier`; codegen errors on `audit` events used as bridge triggers (audit-tier is bridge-inert by design). (`9685021`)
- **`feat(events)` #263 (#246)** — `TypedEventBus` stamps `tier` on publish; audit-tier routing forced to `null` (no bridge delivery). (`160c8a1`)
- **`feat(bridge)` #264 (#247)** — bridge `processEvent` short-circuits on `tier === 'audit'` at the top of the handler, before any work. (`369dfaf`)

### Changed — breaking

- **`feat(sync)!` #235 (#226-2)** — `IChangeSource<T>.listChanges` signature is now `(subscription, cursor)` (cursor passed by value at the port seam, ADR-033). Every in-tree adapter and test fake updated. Downstream consumers must update their adapter shells. (`663b621`)
- **`feat(sync)!` #239 (#226-5)** — `SYNC_LOOPBACK_FINGERPRINT_STORE` no longer a top-level orchestrator binding. Consumers using the orchestrator-side loopback path migrate to `createLoopbackMiddleware(store)` composed into their primitive's middleware chain. Migration documented in `docs/guides/sync-migration.md`. (`f099269`)

### Docs

- `.claude/skills/sync/SKILL.md` — Phase 2 gating sentence flipped to "PollChangeSource emission shipped (provider-keyed); webhook + streaming deferred"; new factory + middleware files added to runtime snapshot.
- `docs/CONSUMER-SETUP.md#sync-subsystem` — "Detection block — provider-keyed codegen factory module" walkthrough added.
- `docs/guides/sync-migration.md` — "Migrating from a hand-authored `IChangeSource` to a provider-keyed `detection:` block" appended.

## [0.4.4] — 2026-04-23

### Fixed

- **`fix(jobs)` #197 — SEVERITY: silent pool-level outage.** `JobWorkerModule` was passing `def.queue` (e.g. `'jobs-crm-sync'`) as the worker's claim-filter pool, but the orchestrator writes the logical `poolName` (e.g. `'crm_sync'`) into `job_run.pool` from `@JobHandler.meta.pool`. As a result, **no job in any stack using `@JobHandler` was ever claimed by a worker** — the claim query never matched a row, zero exceptions were raised, and the pool sat idle. Every consumer of the jobs subsystem since pools-and-queues diverged was affected. Fixed by passing `poolName` as the worker's `pool`. If you ran 0.4.0–0.4.3 with `@JobHandler` handlers: any jobs enqueued in that window are still pending in `job_run` with `status='pending'` and will now claim on next worker tick.
- **`fix(jobs)` #197 — cross-module handler DI scope.** `moduleRef.create(HandlerClass)` only instantiates within `JobWorkerModule`'s scope, so any handler with a cross-module `@Inject` dep (e.g. a sync job injecting a factory from a feature module) crashed at claim time with "not a provider of the current module". The 0.4.3 `ModuleRef` fix was necessary but not sufficient. Switched to `moduleRef.get(HandlerClass, { strict: false })` in both the Drizzle worker and the in-memory orchestrator, which walks the whole DI graph. **New hard requirement**: handler classes MUST be registered as providers in their owning `@Module`. `@JobHandler` registers with the job registry, not with Nest DI — both registrations are required. Documented in `.claude/skills/jobs/handler-authoring.md`.

### Added

- **`feat(events)` #198 — `type: array` payload field.** Closes a silent validation hole. Payloads with list-shaped fields had no well-typed representation; the only option was `type: json`, which emits `Record<string, unknown>` / `z.record(z.unknown())`. At publish time the runtime Zod validator rejected actual arrays, the event was dropped, and downstream `bridge_delivery` rows never landed — with no surfaced error. Now: `type: array` with a required scalar `items:` (`uuid | string | number | boolean | date`) emits `T[]` + `z.array(T)`. Nested arrays / nested json inside an array are deliberately rejected — payloads are a wire format, not an embedded schema. Consumer migration: change any list-shaped payload field from `type: json` to `type: array, items: <scalar>`, re-run `codegen events`, drop any `as unknown as Record<string, unknown>` publish-site casts.

## [0.4.3] — 2026-04-22

### Fixed
- **`fix(jobs)`** — handlers are now instantiated via `ModuleRef` so `@Inject()`-annotated constructor parameters resolve correctly. Applies to both the Drizzle and in-memory job backends. Before this fix, handlers with DI-injected dependencies would fail at runtime because the worker constructed them outside Nest's container. (commits e7348cd, c685a63)
- **`fix(bridge)` #193** — bridge registry codegen is gated on the bridge subsystem being installed (PR #192), and `bridgeHandlersDir` now resolves under `paths.backend_src` instead of hard-coding `src/jobs` (PR #194). Together these close the "stray `src/shared/subsystems/bridge/generated/registry.ts` with broken `../bridge.protocol` import" bug for both the "bridge declared in config but not installed" case and the "installed with non-default backend_src so triggers were never scanned" case.

## [0.4.1] — 2026-04-21

### Added
- **`codegen project upgrade-openapi`** — surgical AST-based codemod that brings an existing consumer `src/app.module.ts` + `src/main.ts` up to the OPENAPI-4 shape `project init` emits on a fresh project. Merges `@nestjs/common` imports, adds `OpenApiModule` (the `@Global()` wrapper around `OPENAPI_REGISTRY`), wires it into `AppModule.imports`, injects the two-pass Swagger bootstrap into `main.ts`, and vendors `src/shared/openapi/*`. Idempotent; `--dry-run` and `--path` supported. Proof-of-concept for issue #188 (additive subsystem install, targeted for 0.5.0).
- **`src/cli/shared/ast-patch.ts`** — ts-morph patching primitives (`ensureImport`, `ensureClassDeclaration`, `ensureModuleImportEntry`, `ensureMainSwaggerBlock`). Each is idempotent and bails cleanly on exotic shapes (factory-based modules, non-array `imports`, missing `@Module()` decorator).

### Changed
- **`project init` skip reasons** — when `app.module.ts` or `main.ts` exist, the skip message now points at `codegen project upgrade-openapi` as the automated path (previously instructed manual wiring only).

### Dependencies
- Added `ts-morph` (runtime dep; CLI-side) for AST manipulation.



### Added
- **Noun-verb CLI** — Clipanion-based CLI replacing the legacy single-file handler. Commands: `entity`, `subsystem`, `project`, `dev`. Each noun has a summary pane with dynamic hints. (ADR-015)
- **UI toolkit** — chalk theme tokens, icons with ASCII fallback, Ora spinners, pane/hints rendering, `--json` mode across all commands. (ADR-016)
- **Barrel files** — `src/generated/modules.ts` and `src/generated/schema.ts` replace app.module.ts injection. Codegen never touches user-authored files. (ADR-017)
- **`codegen init`** — scaffolds a consumer project: codegen.config.yaml, tsconfig path aliases, DatabaseModule, runtime shims, empty barrels, example entity YAML.
- **`codegen dev`** — manages Docker services (Postgres + Redis), starts/stops the NestJS app, shows health dashboard with endpoint probing.
- **Redis event bus** — `EventsModule.forRoot({ backend: 'redis' })` using ioredis Pub/Sub. Optional peer dependency.
- **Declarative query methods on repository** — clean-lite-ps repository template now generates `findByX` methods from the `queries:` block.
- **Smoke test harness** — `just test-smoke` scaffolds a fresh project, generates entities, runs `tsc --noEmit`. Catches template and import regressions.
- **Consumer setup docs** — `docs/CONSUMER-SETUP.md` covering the full wire-up contract: tsconfig aliases, DatabaseModule, runtime shims, barrels.
- **Browser-pilot agent** — Playwright + Chrome DevTools + Lighthouse MCP for endpoint verification and visual QA.
- **Team agents** — architect, builder, coordinator, validator adapted for codegen-patterns workflows.
- **Dev companion commands** — `/dev-check`, `/dev-test`, `/dev-debug` for interactive development with teammate/subagent fallback.
- **Claude Code skill** — `.claude/skills/codegen/SKILL.md` teaches Claude the full CLI reference. Install with `just install-skill <target>`.

### Changed
- **Package renamed** from `@anthropic/codegen` to `@pattern-stack/codegen`.
- **Repo reorganized** — source under `src/`, shipped runtime under `runtime/`, tests under `src/__tests__/`. Root cut from ~17 directories to 5.
- **`output/` renamed to `src/formatters/`** for clarity.
- **`shared/` renamed to `runtime/`** — makes the generator-vs-emitted boundary visible.
- **`generate.cleanLitePs`** replaced by `generate.architecture: 'clean' | 'clean-lite-ps'` enum. No deprecation shim (no existing users).
- **`generate.frontend`** added (default `false`). Scanner flips true when `apps/frontend/` detected.
- **Use case naming** — declarative queries now emit entity-prefixed names (`FindAccountByDomainUseCase`, not `FindByDomainUseCase`). Prevents cross-entity collisions.
- **WithAnalytics mixin** — preserves abstract base class type and method signatures through the mixin chain.
- **`baseQuery()`** uses Drizzle `$dynamic()` for consistent return type. Fixes `.where()` chaining in all family repositories.
- **Subsystem install default path** — `shared/subsystems/` (was `src/shared/subsystems/`).
- **Drizzle backend filter** — `subsystem install --backend drizzle` now keeps memory backend too (needed for tests).

### Fixed
- Clean-lite-ps and clean-architecture templates no longer both emit when one is selected.
- Frontend templates no longer emit when `generate.frontend` is false.
- `app.module.ts` injection removed entirely (replaced by barrels).
- Templates dir resolves correctly when CLI invoked from outside the repo.
- WithAnalytics template import changed from `base-analytics-service` to `with-analytics` (matches runtime filename).
- EJS HTML-escape in declarative query templates — enum union types (`'active' | 'inactive'`) no longer rendered as `&#39;active&#39;`.
- Validator includes `belongs_to` foreign key fields in available-fields set for query validation.
- `MetadataEntityRepository.upsertMany` signature matches base class (conflictTarget now optional).
- `Column` import from drizzle-orm/pg-core changed to `PgColumn` (matches 0.45 exports).
- `prompt.js` config imports fixed after `src/` reorg.

### Removed
- Legacy `src/cli.ts` (25K single-file CLI) — replaced by `src/cli/` noun-verb architecture.
- 11 Hygen inject templates that mutated `app.module.ts` and `schema.ts`.
- Stale docs: `CODEGEN-EVOLUTION-PLAN.md`, `SNAKE_CAMEL_SYNC.md`, `context-engine.md`, `v2-initiative-overview.md`, `contact-module-sketch.md`.
- Empty `tools/` directory.

## [0.2.0] - 2026-04-12

### Added
- Infrastructure subsystems: events, jobs, cache, storage (ADR-008). Protocol → Backend → Factory pattern.
- CRM family renamed to Synced (domain-agnostic).
- Getting Started guide.
- Declarative query codegen from `queries:` YAML block.
- Clean-Lite-PS template pipeline.
- Entity family base classes (synced, activity, metadata, knowledge).
- BaseRepository and BaseService with behavior injection.
- Project scanner for convention detection.

## [0.1.0] - 2026-04-12

Initial release. YAML schema, parser, analyzer, Hygen template pipeline, baseline test infrastructure.
