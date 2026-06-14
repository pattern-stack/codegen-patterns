# RFC-0005 — Jobs definition kind: `JobDefinitionSchema` + emitter (Part B)

**Status:** Draft — schema (#5) + loader (#6) landed; emitter/validator (#7–#8) pending
**Date:** 2026-06-14
**Owner:** Doug
**Related:** swe-brain **ADR-0018** (the A→B decision record + the three shapes — *this RFC is the codegen-side byte contract for it*); ADR-039 (time as an event source — the `schedule` arm desugars to a generated scheduled event); ADR-033/033.1 (`detection:` config + `DetectionConfigSchema`, embedded here verbatim); ADR-023 (event→job bridge — the `event` trigger arm); RFC-0003 (`historyId`/`syncToken` cursors); `runtime/subsystems/jobs/job-handler.base.ts` (`JobHandlerMeta` — the 8 fields surfaced); codegen #458/#414/#457 (the soft-ordered registry follow-ups). Grounding: `.ai-docs/research/jobs-kind-design-brief.md` (the 10-agent grounding brief; §3 is the schema this RFC freezes).

## Goal

swe-brain hand-authored four sync `@JobHandler` classes (`inbound-sync`, `reconcile-poll`, `google-reconcile`, `drive-poll`) sharing a copy-pasted shell + a re-declared `PhaseSummary` struct ×4. Each is a **composite of source-usage shapes** (poll / reconcile / realtime) layered over the two change-source modes codegen owns (`poll | webhook`). Codegen has **no jobs definition kind** today — the only `@JobHandler` touch is the bridge-registry generator's AST scan of authored `.ts` (architectural intent, not oversight).

This RFC introduces the **jobs definition kind**: `definitions/jobs/*.yaml` → `JobDefinitionSchema` → a generated `@JobHandler` skeleton. The load-bearing contract (ADR-0018):

> **A per-adapter sync-profile object IS a `JobDefinition`.** swe-brain (Part A) authors the YAML; codegen (Part B) compiles it. The schema is the **byte contract** — swe-brain freezes against the shape this RFC locks, then dogfoods the emitter at the npm-publish gate.

## Design anchors (from the grounding brief, ADR-0018 D1–D5)

- **D1 — Realtime is a webhook-DRAIN MODE, not a peer primitive.** `arm.kind: realtime` reuses the embedded `read.mode: webhook`; claim/ack lives in the handler. No third change-source mode. `DetectionConfigSchema` stays `discriminatedUnion('mode', [Poll, Webhook])`, untouched.
- **D2 — Per-run `differOverride` DEFERRED.** The only differ touchpoint is the global `integration.differ.unignore`; a per-job override is surfaced declaratively (`differ.unignore`) but its runtime wiring is deferred.
- **D3 — FRESH `JobDefinitionSchema`; `DetectionConfig` composed per-arm.** None of the 8 requested profile fields exist in `DetectionConfig` (it is a single-source detection leaf, ADR-033). The job schema is a multi-arm composite that **imports** `DetectionConfigSchema` as a read leaf — never adopts it as backbone, never widens it.
- **D4 — Cadence is owned by the JOB** (ADR-0018, **overriding** the brief's D4 event-owned recommendation — Doug: "the job declares its own cadence; I'm not setting up timers then attaching jobs"). `triggers[]` is a list of two arm shapes: a **`schedule` arm** carries the authoritative cadence (the emitter generates a job-private scheduled event + bridge trigger from it, à la EMIT-CHANGES); an **`event` arm** references an existing event. No cadence mirror, no drift-check — there is no separate event to drift against.
- **D5 — `(provider,domain)→use-case` registry is a swe-brain-local throwaway now; codegen #458 is NOT a Part B blocker.** Zero schema surface.

## Two discriminated unions at two altitudes (D1 ↔ D3)

```
arm.kind     : poll | reconcile | realtime      ← source-USAGE shape   (job-arm altitude)
read.mode    : poll | webhook                   ← change-source mode   (embedded DetectionConfig leaf)
```

A realtime arm carries `kind: realtime` AND `read.mode: webhook`. A single job freely mixes arms (`inbound-sync` = realtime + realtime + poll) — the altitudes are independent everywhere except the one cross-arm invariant below.

## The frozen schema (`src/schema/job-definition.schema.ts`)

```
JobDefinition (top level, .strict())
├─ type          string (snake_case, required)   # == @JobHandler('<type>')
├─ pool          string?                          # JobHandlerMeta.pool — the execution lane
├─ scope         { entity: snake, from: string }? # JobHandlerMeta.scope; `from` = {{field}} template
├─ retry         { attempts, backoff: fixed|exponential, baseMs, nonRetryableErrors? }?
├─ concurrency   { key: string, collisionMode: queue|reject|replace }?   # key = {{field}} template
├─ dedupe        { key: string, windowMs }?       # JobHandlerMeta.dedupe (DedupePolicy) — the job dedupe WINDOW
├─ timeoutMs     number?
├─ replayFrom    scratch|last_step|last_checkpoint?
├─ differ        { unignore: string[] }?          # the differ knob (maps to integration.differ.unignore)
├─ triggers      Trigger[]  (default [])          # D4: 0/1/N. union of two arm shapes:
│   ├─ { schedule: ScheduleSchema }               #   schedule arm — job-owned cadence; emitter GENERATES
│   │                                             #     a job-private scheduled event + bridge trigger.
│   │                                             #     ScheduleSchema reused verbatim from events.
│   └─ { event: snake }                           #   event arm — references an EXISTING event; emitter emits a bridge trigger.
├─ arms          Arm[]  (min 1)                    # D1+D3: the multi-arm composite, discriminated on kind
│   ├─ poll      { kind:'poll',      domain, read: DetectionConfig(mode:poll) }
│   ├─ reconcile { kind:'reconcile', domain, window:{hours>0}, cursorWithheld:true, read: DetectionConfig(mode:poll) }
│   └─ realtime  { kind:'realtime',  domain, staging:{table, pushAccelerate?}, read: DetectionConfig(mode:webhook) }
└─ description   string?                           # optional free-text; ignored by the emitter

read: DetectionConfigSchema   # IMPORTED from runtime/subsystems/integration — REUSED, never redefined (ADR-033)
```

**Cross-arm invariant** (superRefine): `kind: realtime ⇒ read.mode: webhook`; `kind: poll|reconcile ⇒ read.mode: poll`.

### Three codegen-side resolutions of the brief §3 (deviations, with rationale)

The brief §3 was a paper sketch; authoring against the real runtime types surfaced three naming/shape wrinkles. Each is resolved on architectural-correctness grounds (CLAUDE.md — no backwards compat to preserve):

1. **The differ knob is `differ.unignore`, NOT the brief's `dedupe.unignore`.** `JobHandlerMeta.dedupe` is a real `DedupePolicy { key, windowMs }` (a job-level dedupe *window*) and is one of the 8 meta fields the schema must surface. The brief overloaded the name `dedupe` for the differ-unignore knob — an incompatible shape. Resolution: `dedupe` surfaces the runtime DedupePolicy; the differ knob is `differ.unignore`. (swe-brain's `reconcile-poll.yaml` authors `differ: { unignore: [deletedAt] }`.)
2. **No top-level `lane` field.** The brief listed `lane: string?` "(maps to pool config)". There is no `lane` in `JobHandlerMeta` — grep finds it only in JOB-FN-KEY comments about the concurrency *key*. The execution lane is `pool`. Dropped.
3. **Function-valued meta fields are modelled as declarative strings.** `scope.from`, `concurrency.key`, `dedupe.key` are `(input) => string` in the runtime; in YAML they are `{{field}}` template strings the emitter compiles. `triggers[].map`/`when` are omitted entirely — the emitter generates them. The schema models only the YAML-authorable declarative surface.

### Canonical authoring reference

`test/fixtures/jobs/{drive_poll,reconcile_poll,inbound_sync}.yaml` are the canonical authoring examples — they validate against the schema (filename == `type`, snake_case). The grounding brief's inline §3 YAML (`.ai-docs/research/jobs-kind-design-brief.md`) is **illustrative and pre-resolution**: it predates the snake_case `type` decision (`drive_poll`, not `drive-poll`), abbreviates cursors without the mandatory `field`, and still lists the dropped `lane` field. Author against the fixtures, not the brief snippets.

### Negative space (proves the decisions)

- No third change-source mode/arm for realtime (**D1**). No `differOverride` on the run input — `differ.unignore` is the only differ touchpoint, job-wide (**D2**). No widening of `DetectionConfigSchema` — imported verbatim (**D3**). Cadence is job-owned via the `schedule` arm (the emitter generates the scheduled event) — no cadence mirror, no drift-check (**D4**). No `(provider,domain)→use-case` registry surface (**D5**).

## Per-arm emitter semantics (forward reference for #7)

| Arm | Source behaviour | Cursor | Mode | Declarative inputs the emitter consumes |
|---|---|---|---|---|
| `poll` | DI-bound adapter walks the delta | ADVANCES | poll | `read` (DetectionConfig) |
| `reconcile` | windowed `sourceOverride` (now − `window.hours`), tombstone inference | WITHHELD | poll | `window.hours`, `cursorWithheld`, `read` |
| `realtime` | webhook-staging drain, claim/ack in handler | n/a (drain) | webhook | `staging.{table,pushAccelerate}`, `read.webhook` |

## Work breakdown (codegen side of the brief §4)

| # | Item | Status |
|---|---|---|
| 5 | `src/schema/job-definition.schema.ts` (fresh, imports DetectionConfig) + unit tests + living-docs fix to `detection-config.schema.ts` header | **landed (this RFC)** |
| 6 | `definitions/jobs/` loader (`loadJobs` + `loadJobFromYaml`) + `resolveJobsDir` (`paths.jobs_dir`, fallback `definitions/jobs`) + parser export. **Correction:** NO `detectYamlType` branch — that discriminator is for the entity-family files (entity/relationship/junction) in the entities dir; events and jobs both carry a top-level `type:` and load by **directory** (`loadEvents`/`loadJobs`), never through `detectYamlType`. Enforces filename↔`type` + duplicate-type, mirroring `loadEvents`. No cross-ref (triggers→events is #8). | **landed** |
| 7 | Jobs emitter (`src/emitters/` or `src/cli/shared/`) + `entity new` post-step; define generated-skeleton vs AST-scanned-`@JobHandler` coexistence | pending |
| 8 | Cross-ref validator: each **`event`-arm** `event` must exist in the generated `eventRegistry`; each **`schedule`-arm** generates a job-private scheduled event (merged into the registry like EMIT-CHANGES) — no drift-check (cadence is job-owned). Update ADR-039 + events skill same PR | pending |
| 9 | `just test-smoke-integration` green for the jobs emitter (must tsc-compile the emitted tree) | pending |
| 10 | 🚦 RELEASE GATE — `just bump` + main→npm auto-deploy; `just test-post-publish` first; swe-brain dogfoods the *published* tarball | pending |

**Critical path:** #10 is the only hard cross-repo serialization point. swe-brain's dogfood (#11 in the brief) consumes the published tarball, so it cannot start until the emitter is live on npm. After this schema (#5) is frozen, swe-brain's Part A build and codegen's #6–#9 parallelize.

## Open questions

- **OQ-1 (#7):** generated handler skeleton vs the bridge-registry generator's AST scan of authored `@JobHandler` in `<backend_src>/jobs` — the flat `jobs/` layout is load-bearing (the generator scans only that dir). #7 must define coexistence so the event→job bridge harvest is not broken.
- **OQ-2 (#7/D2):** does `differ.unignore` get a per-job runtime home (a generated per-job differ rebind), or stay a documented no-op until a per-job need is proven? D2 deferred the wiring; the schema froze the surface.
- **OQ-3 (#7/#8) — schedule-arm event generation:** the schedule arm desugars to a generated, job-private scheduled event. Open: the generated event's **naming** (e.g. `<job_type>__sched`) and **merge** into the event registry (mirror the EMIT-CHANGES `desugar*` path in `load-events.ts` that folds synthesized events into the registry). Each schedule arm gets its own event — equal cadences do NOT coalesce (a shared tick is opt-in: author an event + use an `event` arm). The cadence-mirror drift-check from the brief's D4 is **dropped** (cadence is job-owned; nothing to drift against).
- **OQ-4 (PROVIDER IDENTITY) — DECIDED (b), 2026-06-14 (Doug).** The contract is a "per-ADAPTER sync-profile", yet the schema carries no provider/adapter identity — arms carry only `domain`. The integration assembly is keyed `(provider, entity)` (`assembly-emission-generator.ts` builds `<ENTITY>_INTEGRATION_USE_CASE__<PROVIDER>`), and a single job spans providers (`inbound-sync` = Slack message/reaction + Google email), so `provider` cannot be a single top-level field. **Resolution (b): provider stays OUT of the YAML** — resolved swe-brain-side by the D5 throwaway `(provider,domain)` registry for the dogfood, revisited when #458 lands. Rationale: minimal surface; D5 already keeps provider resolution A-side; adding a per-arm field before #7 proves its shape risks freezing the wrong shape. The rejected alternative (a) was an optional per-arm `provider: snake_case`. If #7/#458 prove a YAML provider is needed, (a) is the additive escape hatch.
- **OQ-5 (#7):** duplicate arm `domain` within one job is currently accepted; the per-entity change-source contribution is keyed by entity (`adapter.changeSources['<entity>']`), so two arms sharing a domain collide at emit time. #7 must define whether same-entity multi-arm (e.g. poll + reconcile on one entity) is legal — and if so, key by `(kind, domain)` — or reject duplicate domains. Left un-enforced in #5 to avoid freezing a possibly-wrong constraint.
- **OQ-6 (#6/#8/#9):** typos INSIDE the `read:` leaf are silently stripped (the imported `DetectionConfigSchema` is non-strict per ADR-033; the job schema must not widen it). The #6 loader / #8 validator / #9 smoke gate is the real backstop — see project memory `feedback_smoke_filter_signal` (a smoke filter that hides this would be the bug).
