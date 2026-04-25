# Issue #226 — Config-Driven Change Sources: PR-Sized Plan

## 1. Context

Issue #226 makes change-source detection config-driven: poll/CDC/webhook adapters become reusable primitives (`PollChangeSource<T>`, `CdcChangeSource<T>`, `WebhookChangeSource<T>`) parameterized by a declarative `DetectionConfig` (field mappings, filters, cursor strategy) emitted from per-entity YAML. Loopback de-dup becomes a stock `ChangeMiddleware<T>`, deleting the orchestrator's special-case branch. The decision memo at `/tmp/issue-226-decisions.md` locks Q1–Q6: cursor passes through `listChanges(subscription, cursor)` (Q1), loopback ships as middleware (Q2), `SyncSubscriptionView` stays 3-field (Q3), `DetectionConfig` Zod schema lives in `runtime/subsystems/sync/` (Q4), `PollFetchContext` drops run-scoped fields (Q5), and `detection:` lives per-entity in YAML with a generated factory module (Q6). Phase 1 (PRs 1–5) is runtime + protocol; Phase 2 (PRs 6–7) is codegen; downstream Dealbrain migration is out of scope.

## 2. Issue list

---

### #226-1: ADR-033 + DetectionConfig Zod schema + ChangeMiddleware<T> types

**Scope:** New ADR `docs/adrs/ADR-033-config-driven-change-sources.md` (upstream copy/refinement of `/tmp/adr-0002.md` amendment, scoped to upstream subsystem architecture). New `runtime/subsystems/sync/detection-config.schema.ts` exporting Zod schema + inferred TS types (field-mapping, `ResolvedFilter`, cursor-strategy union, `DetectionConfig`). New `runtime/subsystems/sync/sync-middleware.protocol.ts` defining `ChangeMiddleware<T>` and the composition helper signature. Re-export both from `runtime/subsystems/sync/index.ts`. Pure types + docs; no runtime behavior change.
**Blocks/Blocked by:** Blocks #226-3, #226-4, #226-6. Blocked by: none.
**Acceptance:**
- ADR-033 lands in `docs/adrs/`, status `Accepted`, references decision memo Q1–Q6 in rationale, and explicitly amends ADR-0002's `IChangeSource<T>.listChanges` signature.
- `DetectionConfigSchema` parses fixture configs covering all three modes; type inferred via `z.infer`.
- `ChangeMiddleware<T>` type signature matches `(next) => (subscription, cursor) => AsyncIterable<Change<T>>` (or equivalent locked shape).
- `runtime/subsystems/sync/index.ts` re-exports both modules, mirroring `FieldDiffSchema` precedent.
- `just test-unit` green; new schema has unit-test coverage.
**Out of scope:** Primitive implementations; orchestrator changes; YAML wiring.
**Skill/spec updates required:**
- `.claude/skills/sync/SKILL.md` — append entry under "Current runtime snapshot" for the two new files; add a "Non-obvious rule" item that detection config is the canonical source of filter/mapping shape.
- `docs/adrs/ADR-008-subsystem-architecture.md` — add a dated revision note pointing to ADR-033 if relevant.

---

### #226-2: Cursor-at-seam protocol expansion (BREAKING)

**Scope:** Change `IChangeSource<T>.listChanges(subscription)` to `listChanges(subscription, cursor)` in `runtime/subsystems/sync/sync-change-source.protocol.ts`. Update `ExecuteSyncUseCase` (`execute-sync.use-case.ts:156`) to pass `cursorBefore` through. Update every existing in-tree adapter/test fake (memory backends, unit-test doubles under `runtime/subsystems/sync/__tests__/` and `src/__tests__/`). Update `SKILL.md` rules 1, 2, and the L80–82 routing row.
**Blocks/Blocked by:** Blocks #226-3, #226-5. Blocked by: #226-1 (for ADR reference).
**Acceptance:**
- `IChangeSource<T>.listChanges` signature is `(subscription: SyncSubscriptionView, cursor: unknown | null) => AsyncIterable<Change<T>>`.
- Orchestrator passes the value it already reads at `execute-sync.use-case.ts:137` (`cursorBefore`) into the call.
- Every in-tree implementation and test double compiles + passes; no `// TODO cursor` shims.
- `just test-unit` and `just test-baseline` green.
**Out of scope:** New primitives; loopback removal; codegen.
**Skill/spec updates required:**
- `.claude/skills/sync/SKILL.md` — update rule 2 ("Cursors are opaque at the port seam") to reflect the new dual reader (orchestrator owns lifecycle; primitive receives by-value).
- ADR-033 cross-link added in protocol-and-ports L1 if present.

---

### #226-3: PollChangeSource<T> primitive + unit tests

**Scope:** New `runtime/subsystems/sync/poll-change-source.ts` implementing `IChangeSource<T>` parameterized by `DetectionConfig` + `PollFetchCallback<T>`. Drops `userId`/`tenantId` from `PollFetchContext` per Q5. Wires filter resolution, field mapping, cursor strategy. Unit tests under `runtime/subsystems/sync/__tests__/poll-change-source.test.ts`. Re-export from `index.ts`.
**Blocks/Blocked by:** Blocks #226-6, #226-7. Blocked by: #226-1, #226-2.
**Acceptance:**
- `new PollChangeSource<T>({ adapter, config, middlewares? })` constructs cleanly; `listChanges(subscription, cursor)` yields `Change<T>` with `source: 'poll'`.
- Filter resolution applies flat-AND vocabulary as locked (defer richer expressions per epic open Q3).
- `PollFetchContext = { subscription, cursor, filters }` — no `userId`/`tenantId`.
- Unit tests cover: empty cursor, advancing cursor, filter passthrough, middleware chain composition, field-mapping, error-from-callback.
- `just test-unit` green.
**Out of scope:** CDC/webhook primitives; loopback factory; codegen.
**Skill/spec updates required:**
- `.claude/skills/sync/SKILL.md` — add primitive to runtime snapshot; add a "Non-obvious rule" that `userId`/`tenantId` are closed over by the consumer at construction, not threaded through `PollFetchContext`.

---

### #226-4: WebhookChangeSource<T> primitive + CDC-as-provenance config knob

**Scope:** New `runtime/subsystems/sync/webhook-change-source.ts` mirroring the poll primitive's shape — iterates a consumer-owned inbound staging queue, sets `source: 'webhook'`, populates `dedupKey` from event-id. Add `provenance?: 'poll' | 'cdc'` to `DetectionConfig.poll` (defaults to `'poll'`). When set to `'cdc'`, `PollChangeSource<T>` stamps emitted `Change<T>.source = 'cdc'` and populates `dedupKey` from a configured event-id field. Unit tests for both. Re-export from `index.ts`.

**Rationale (redesign — see decision memo addendum):** CDC is not a standardized transport like webhook is. It covers four genuinely different mechanisms (Stripe-style events endpoint, SFDC Pub-Sub gRPC stream, Debezium/Kafka, Postgres logical replication). Stripe-style "CDC" is mechanically a poll with `event_id` cursor — `PollChangeSource` already covers it; the only difference is the `Change<T>.source` provenance tag. Long-lived subscription-based CDC (SFDC Pub-Sub, Debezium) needs a fundamentally different primitive (`subscribe(onChange, onError)` lifecycle, ack-on-yield, server-paced backpressure) and is deferred to `#226-8` until a real consumer migrates onto it.

**Blocks/Blocked by:** Blocks #226-6. Blocked by: #226-1, #226-2, #226-3 (provenance knob lives on the poll primitive).
**Acceptance:**
- `WebhookChangeSource<T>` implements `IChangeSource<T>` with the new signature; treats inbound queue as iterator source; does not synchronously drive orchestrator.
- `DetectionConfig.poll.provenance` accepted by Zod schema; `PollChangeSource<T>` honors it (stamps `source: 'cdc'` + populates `dedupKey` from configured event-id field when set).
- Unit tests cover: webhook event-id dedup, empty-queue iteration, queue-error surfacing; poll-with-cdc-provenance emits `source: 'cdc'` + correct `dedupKey`.
- `just test-unit` green.
**Out of scope:** Inbound staging table schema (deferred per ADR-0002 §Phase 4 — consumer-owned); long-lived streaming primitive (`#226-8`); codegen emission.
**Skill/spec updates required:**
- `.claude/skills/sync/SKILL.md` — runtime snapshot row for `webhook-change-source.ts`; update non-obvious rule #1 to clarify that "CDC" maps to `PollChangeSource` with `provenance: 'cdc'` for cursor-based event endpoints, and that long-lived stream subscriptions are a separate primitive.

---

### #226-8 (deferred — placeholder): StreamChangeSource<T> for long-lived subscriptions

**Status:** Deferred until first real consumer (likely SFDC Pub-Sub API or Debezium-on-Kafka). Not part of this epic.
**Why deferred:** The streaming substrate (gRPC long-lived connection, server-paced backpressure, per-event ack contracts, reconnect-on-disconnect lifecycle) is fundamentally different from `(cursor) => AsyncIterable` and shouldn't be designed speculatively. The originator's January implementation sat on SFDC CDC — when that consumer migrates upstream, the primitive's shape will be informed by real requirements rather than guessed.

---

### #226-5: Loopback-as-middleware migration (BREAKING)

**Scope:** New `runtime/subsystems/sync/loopback.middleware.ts` exporting `createLoopbackMiddleware(store: ILoopbackFingerprintStore<T>): ChangeMiddleware<T>`. Delete the loopback branch in `execute-sync.use-case.ts:253-271`, the `@Optional() SYNC_LOOPBACK_FINGERPRINT_STORE` injection (`:117-119`), and the token export from `sync.tokens.ts:39-40`. The `ILoopbackFingerprintStore<T>` *protocol* survives (`sync-loopback.protocol.ts` stays). Update orchestrator unit tests to either (a) compose the middleware into a fake `IChangeSource` or (b) drop loopback assertions where they are now middleware-side. Add unit tests for `createLoopbackMiddleware`.
**Blocks/Blocked by:** Blocks #226-6 (factory composes loopback). Blocked by: #226-1, #226-2, #226-3.
**Acceptance:**
- `SYNC_LOOPBACK_FINGERPRINT_STORE` token is gone from `sync.tokens.ts`; no `grep` hits in `runtime/`.
- Orchestrator no longer references `loopback`; flow tests still pass.
- `createLoopbackMiddleware` unit tests cover: matching fingerprint suppresses change, missing fingerprint passes through, store interaction.
- `just test-unit` and `just test-baseline` green.
**Out of scope:** Consumer migration (Dealbrain — downstream).
**Skill/spec updates required:**
- `.claude/skills/sync/SKILL.md` — update L80–82 orchestrator-flow row (loopback no longer orchestrator-side); update "Current runtime snapshot" to remove the orchestrator's loopback injection and add the middleware factory; remove the "no parallel old/new" risk by deleting cleanly per CLAUDE.md.
- `runtime/subsystems/sync/sync.module.ts` header comment — drop loopback wiring example.

---

### #226-6: Entity YAML `detection:` block schema (no codegen yet)

**Scope:** Extend `src/schema/entity-definition.schema.ts` with optional `detection?: DetectionConfig` field, importing the Zod schema from `runtime/subsystems/sync/detection-config.schema.ts`. Add fixture entity `test/fixtures/<existing-fixture>.yaml` extension (or new fixture) exercising a poll-mode detection block. Unit tests for parser/validator coverage. **No template/codegen emission yet** — this PR validates only.
**Blocks/Blocked by:** Blocks #226-7. Blocked by: #226-1.
**Acceptance:**
- `entity-definition.schema.ts` parses YAML containing a `detection:` block; rejects malformed configs with clear errors.
- `just validate-entities` succeeds on existing fixtures (additive — `detection` is optional).
- Cross-tree import (`src/schema/` → `runtime/subsystems/sync/`) compiles; if it doesn't, this PR resolves the path/tsconfig (memo Q4 calls this out).
- `just test-unit` green.
**Out of scope:** Factory module emission; baseline snapshot updates; consumer YAML migration.
**Skill/spec updates required:**
- README.md `Configuration` section — add `detection:` to entity YAML reference.
- `.claude/skills/sync/SKILL.md` — note that Phase 2 entity-YAML detection block is now schema-validated upstream.

---

### #226-7: Codegen factory module emission + baseline snapshot

**Scope:** Extend `templates/entity/new/backend/` with a new Hygen template emitting a per-entity `<entity>-sync-source.module.ts` factory that constructs `new PollChangeSource({ adapter: inject(ADAPTER_TOKEN), config: detectionConfig, middlewares: [...] })` and binds to `SYNC_CHANGE_SOURCE`. Adapter-callback tokens are consumer-registered (per memo Q6 and existing `OpportunitySyncModule` example in `sync.module.ts:46-58`). Update `test/baseline/` snapshot for the fixture extended in #226-6. Smoke-test that the generated module typechecks.
**Blocks/Blocked by:** Blocks: nothing upstream. Blocked by: #226-3, #226-5, #226-6.
**Acceptance:**
- For a fixture with `detection:`, `just gen` emits `<entity>-sync-source.module.ts` referencing the consumer-side adapter token and composing locked middleware list.
- `just test-baseline` green with regenerated snapshot.
- `just test-smoke` green — generated module compiles in a fresh project.
- No emission when `detection:` is absent (greenfield-safe).
**Out of scope:** CDC / webhook factory templates (defer until first consumer demands; Poll is the priority path); per-subscription overrides; mode-fallback semantics.
**Skill/spec updates required:**
- `.claude/skills/sync/SKILL.md` — flip the Phase 2 gating sentence (lines ~18–20) from "not shipped" to "Phase 2 PollChangeSource emission shipped; CDC/webhook deferred"; add factory file to runtime/template snapshot.
- `docs/CONSUMER-SETUP.md#sync-subsystem` — add a brief "Detection block" walkthrough.
- `docs/guides/sync-migration.md` — append a "migrating from a hand-authored `IChangeSource` to a `detection:` block" section.

---

## 3. Dependency graph

```
                #226-1 (ADR-033 + types)
                 │
        ┌────────┼────────────────────────────┐
        │        │                            │
        ▼        ▼                            ▼
   #226-2   (parallel after #226-1 lands)  #226-6 (YAML schema)
   cursor-at-seam                           │
        │                                   │
        ├────────────┬─────────────┐        │
        ▼            ▼             ▼        │
     #226-3 ──────► #226-4                 │
     Poll          Webhook +                │
        │          poll.provenance          │
        │            │                      │
              ▼                             │
           #226-5                           │
           loopback-as-middleware           │
              │                             │
              └──────────────┬──────────────┘
                             ▼
                          #226-7
                          codegen factory + baseline
```

**Critical path to Phase 2 codegen emission (#226-7):**
`#226-1 → #226-2 → #226-3 → #226-5 → #226-7`, with `#226-6` running in parallel after `#226-1`. Five sequential merges minimum.

**Maximum parallelism window:** After `#226-2` lands, `#226-3` and `#226-4` can run concurrently; `#226-6` is concurrent with the entire 2→3→5 chain.

## 4. Out of scope (whole epic)

- **Dealbrain consumer-side spec** — does not exist on any branch (per memo §Open coordination); consumer team owns authoring + scheduling.
- **Dealbrain migration PR** — downstream; blocked-by `#226-7` merge; not a sub-issue here.
- **Per-subscription filter overrides** — deferred per memo Q3. `SyncSubscriptionView` stays three fields. Per-tenant divergence achievable today by binding distinct `PollChangeSource` instances per tenant.
- **Mode fallback semantics** (e.g. CDC-with-poll-backstop) — deferred per epic open Q2.
- **Filter expression vocabulary beyond flat AND** (OR / NOT / nested) — deferred per epic open Q3.
- **Webhook codegen factory template** — `#226-7` emits Poll only; webhook factory lands when first consumer demands.
- **Long-lived streaming CDC primitive** (`#226-8`) — SFDC Pub-Sub, Debezium, Postgres logical replication. Different substrate; deferred until a real consumer migrates.
- **Inbound webhook staging table schema** — gated on ADR-0002 §Phase 4.

## 5. Risks

- **Cross-tree import (`src/schema/` → `runtime/subsystems/sync/`) may fail tsconfig path resolution.** → Mitigation: `#226-6` AC explicitly resolves the path issue in the same PR; if blocked, escalate to a small tsconfig-only follow-up rather than copying the schema.
- **Removing `SYNC_LOOPBACK_FINGERPRINT_STORE` (`#226-5`) breaks any in-flight consumer experiment we don't see.** → Mitigation: per CLAUDE.md "no backwards compat," replace cleanly; coordinate via Dealbrain consumer-team channel before merging `#226-5`; ship loopback-middleware factory + migration note in `docs/guides/sync-migration.md` in the same PR.
- **`#226-2` cursor-signature change touches every test fake — diff sprawl could slip past 500 LOC.** → Mitigation: keep `#226-2` ruthlessly mechanical (signature change + arg passthrough only). If diff exceeds budget, split the test-fake updates into a follow-up PR landed back-to-back.
- **Codegen baseline churn in `#226-7` may mask substantive regressions.** → Mitigation: review baseline diff hunk-by-hunk; require the factory module to be the ONLY new file; gate merge on `just test-smoke` green (typecheck, not just snapshot equality).
- **Skill/spec drift across 7 PRs — easy to forget updates and accumulate stale docs.** → Mitigation: each issue's AC has explicit "Skill/spec updates required" bullets; reviewer checklist must verify the .md updates land in the same PR per CLAUDE.md "specs are living documentation."
