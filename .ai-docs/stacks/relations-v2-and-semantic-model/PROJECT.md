# Project charter — Relations v2 + semantic model

**Stack:** `relations-v2-and-semantic-model` · **Tracker:** project #578 · **Board:** https://github.com/orgs/pattern-stack/projects/3
**Owner:** Doug · **Opened:** 2026-09-16 · **Last revised:** 2026-09-17

This is the document every agent and every spec on this project starts from. It says what we are building, why, the
rules no PR may break, and how the project's state is kept current. It is deliberately short on *how* — that lives in
`PLAN.md` (per-unit detail) and in each issue's spec.

**Read order for anyone picking up work:** this file → your epic's issue → your task's issue → `PLAN.md` section named
in the task → ADR-044 / ADR-042 / ADR-041 as relevant → then write or read the spec (`docs/specs/<KEY>.md`).

---

## 1. North star

> **One declaration.** The entity YAML is the only place a domain is described. From it we generate the database
> schema, the relation graph, scoped repositories that traverse that graph, atomic services with typed navigation, the
> semantic model for metrics, and the frontend's entity graph. A developer adds business logic on top; they never
> re-describe the domain in a second place.

A developer who declares `meeting`, `opportunity` and `account` with their relationships should get, with no
hand-written code:

```ts
// any row-shaped path through the graph — one SQL statement, typed, tenant-scoped at every hop
await meetingService.from(id).opportunity().account().opportunities({ limit: 20 }).fetch();

// any aggregate over the same graph — fan-out-safe, through the semantic layer
await queryService.measure('opportunities', { group_by: ['stage'], measures: [{ on: 'amount', agg: 'sum', as: 'pipeline' }] });
```

…and the same graph available on the frontend over TanStack DB collections.

## 2. Target picture

```
                                   entity YAML  (fields · relationships · roles · analytics tags · queries)
                                        │
        ┌───────────────┬───────────────┼────────────────────┬──────────────────────┐
        ▼               ▼               ▼                    ▼                      ▼
   Drizzle schema   defineRelations()  repositories       AggregateModel        frontend collections
   (tables, FKs,    manifest           typed `with`       (declared, for        + relation accessors
    indexes)        (REL-1)            includes, scoped   query-surface)        (FE-REL)
                                       per hop (REL-2)    (SEM-2)
                                            │
                                            ▼
                                   generated services — atomic CRUD, `queries:` finders,
                                   relationship methods, typed navigator (REL-3)
                                            │
                     ┌──────────────────────┴───────────────────────┐
                     ▼                                              ▼
          hand-written use-cases / queries                 query-surface service
          (workflows, cross-entity writes,                 (aggregates, measures, compare)
           side effects)  ── may inject ──────────────────►
```

### Three surfaces, one job each

| Surface | Generated? | Owns | Never does |
|---|---|---|---|
| **Entity services** (+ repositories) | fully, regenerated every run | atomic CRUD; `queries:` finders; row-shaped graph traversal | aggregation; side effects; cross-entity writes |
| **query-surface** (`@pattern-stack/query-surface`) | the model is emitted; the engine is the package | aggregates, measures, ratios, compare, time grains | row CRUD |
| **Use-cases / queries** | hand-written | workflows, transactions, cross-entity writes, side effects, composing the two surfaces above | re-implementing traversal or scoping |

## 3. What already exists — do not rebuild

- `RelationshipSchema` (`belongs_to` / `has_many` / `has_one`, `inverse`), the `relationship` CLI command, the
  `Junction` pattern.
- The pattern library (`Base | Integrated | Activity | Knowledge | Metadata | Junction`), app-definable, with `extends`
  chains and `validate-composition.ts`. ADR-041 (capability composition) is accepted but **unbuilt** — CAP-1 builds it.
- The ADR-038 frontend emitter: TanStack DB collections (`electric` + `api`), `belongs_to` resolvers, `<Class>Refs`.
- OpenAPI emission (`/docs`, `/docs-json`) — downstream client generators already have a spec to target.
- ADR-043 closed-by-default data plane (global guard, `api: false`, no self-asserted headers).
- The `RequesterContext` ALS + `scopeAnd()` choke point in `BaseRepository` that `userTracking` already rides.
- `queries:` — stays. Navigation replaces only FK-shaped finders; non-relationship lookups and their index emission
  remain `queries:`' job.

## 4. Invariants — every spec and PR is checked against these

Reviewers and validators: a PR that breaks one of these is wrong even if its tests pass. Specs must say how they
uphold the ones they touch.

| # | Invariant | In practice |
|---|---|---|
| **I1** | **Declare once.** Every generated artifact derives from the YAML. | Never introspect Drizzle (or anything generated) to recover what the YAML already says. No second place to list join paths, keys or measures. |
| **I2** | **Generated means regenerated.** | Services, repositories, manifest, model and frontend wiring are `@generated`, complete-file, idempotent. No hand-edit seams inside them. If authors ever need a seam, it is an emit-once subclass (the sink pattern), never an editable generated file. |
| **I3** | **Scope lives at the repository, at every hop.** | Tenant (ADR-042, ALS-fed, `strict` for tenant-scoped entities), soft-delete and `userTracking` filters apply to the root *and* every level of an include tree. No capability or service method takes a scope parameter. A missing context throws; it never reads unscoped. |
| **I4** | **A traversal is one statement.** | The navigator is a builder that compiles to a single include tree and executes once. No lazy per-hop accessors, no N+1, no cross-repository composition. |
| **I5** | **Aggregation never rides relations.** | Anything that sums/counts/averages over a to-many path goes through query-surface. The semantic model is *declared*, with per-field `additivity`. |
| **I6** | **HTTP is closed by default.** | Includes over HTTP are a YAML allowlist with a depth cap. A client never supplies a raw include tree. An `api: false` entity is unreachable through an exposed neighbour unless the allowlist names it. Internal callers get the full typed include. |
| **I7** | **No backwards compatibility.** | Replace, don't parallel. No deprecated aliases, no old-and-new composition types, no migration shims (CLAUDE.md). Baselines and snapshots regenerate. |
| **I8** | **Core contract + opt-in extensions.** | Where a backend-specific capability is exposed, it is an extension on top of a portable core — not a uniform interface that hides features. |
| **I9** | **Gates are honest.** | No filtered or ignored error classes. Report gate output from the run made *after* the last edit. A real residual error class gets its own issue, not a filter. |
| **I10** | **This repository is public.** | No consumer, customer, product-strategy, infrastructure or security-defect detail in any file, commit, issue or PR. Refer to "a host application". |
| **I11** | **Scope discipline.** | `clean-lite-ps` is the backend pipeline in scope. Cross-entity files are whole-set TS emitters (ADR-038 precedent); per-entity backend files stay hygen. No consumer-application changes; no consumer production pin to the Drizzle RC. |

## 5. Non-goals

- A metric engine in codegen (query-surface is the engine).
- An OpenAPI path or client generator (shipped / downstream).
- Consumer migration-history continuity across the drizzle-kit format change.
- The full `clean` backend pipeline (ADR-041 defers it; follow-up after this project).
- EAV in the semantic model; `to_shape` projections / selector catalog from the subject-lattice research.
- Merging stale PRs #550, #556, #271 — rebase-and-reassess only if one becomes relevant.

## 6. Units, order, and what "done" means

```
DRZ-1 ─► DRZ-2 ─┬─► TEN-1 ─► REL-1 ─► REL-2 ─► REL-3 ─► FE-REL      epic #580
   epic #579    ├─► SEM-1 ─► SEM-2 ─► SEM-3   (+ query-surface#40)   epic #581
                └─► CAP-1 ─► CAP-2 ─► CAP-3                          epic #582
```

| Epic | Exit criteria (the epic closes when all are true) |
|---|---|
| **#579 Unit 1 — Drizzle 1.0** | Generator, runtime, scaffold and every harness run on `drizzle-orm@1.0.0-rc.4`; no `relations(` emitted; **zero** filtered error classes in smoke; `drizzle-orm` is a peer; tarball smoke green; #576 closed. |
| **#580 Units 2+5 — relation graph** | ADR-042 implemented and proven by cross-tenant integration tests; manifest round-trips YAML → traversal; includes scoped at every hop with leak tests at depth ≥ 3; HTTP include allowlist enforced; services delegate + navigator shipped; CGP-358b composition deleted; frontend accessors emitted and type-checking. |
| **#581 Unit 3 — semantic model** | New `analytics` vocabulary replaces the old; emitted `AggregateModel` type-checks against the published package; CRM slice answers a fan-out-trap measure correctly; query-surface#40 shipped. |
| **#582 Unit 4 — capabilities** | ADR-041 implemented (3-capability fixture compiles); `roles:` parsed/validated and feeding v2 `alias`; `Actor`/`Communication` mixins shipped with ALS scope; `findByRole` round-trips in integration. |

**Checkpoint after DRZ-2 (mandatory).** Before starting any of the three tracks: re-read this charter and `PLAN.md`
against what the 1.0 bump actually surfaced, revise, and post a checkpoint entry on #578. The three tracks are
independent after that and may run in parallel.

**Gate modes.** `gate:human` on TEN-1 and REL-2 (security properties) and FE-REL (open design question). Everything
else is `gate:auto`.

## 7. Decision log

Append-only. A decision that changes an invariant or the target picture also gets an ADR (or a dated ADR revision note).

| Date | Decision | Where recorded |
|---|---|---|
| 2026-09-17 | Relations are the **core contract** for cross-entity reads (option 1); CGP-358b composition is replaced, not paralleled. | ADR-044 |
| 2026-09-17 | Services are generated and atomic; consumers hand-write use-cases/queries on top. Reads may be arbitrarily deep traversals; writes/workflows are use-cases. | ADR-044 §2–3 |
| 2026-09-17 | Tenant scope is ALS-fed at the repository, `strict` for tenant-scoped entities. ADR-042 → Accepted; precondition for traversal. | ADR-042 note |
| 2026-09-17 | Metric layer = `@pattern-stack/query-surface`. Codegen emits the declared `AggregateModel`. The package is changed (1.0 peer, `has_one`, publish), not worked around. | PLAN §5.6, query-surface#40 |
| 2026-09-17 | Typed **navigator** on the generated service; every declared relationship navigable internally by default; HTTP exposure separately allowlisted. | ADR-044 §2, §7 |
| 2026-09-17 | DRZ-1 leaves the relations slot empty; REL-1 fills it. | PLAN §4.2 |
| 2026-09-17 | Building the generator on the Drizzle 1.0 **prerelease** line is approved. `drizzle-orm` becomes a peer + dev dependency. | PLAN §4.3 |
| 2026-09-17 | Electric parity restated: both sides project from the same declared graph (frontend unit 5). | ADR-044 |
| 2026-09-17 | `queries:` stays for non-relationship lookups + index emission. | PLAN §5A.6 |

### Open questions

| # | Question | Blocks | Recommendation | Owner |
|---|---|---|---|---|
| Q1 | Frontend include mechanism: in `@pattern-stack/frontend-patterns` with thin generated wiring, or fully generated? | FE-REL design | `frontend-patterns` (the `createEntityHooks` precedent) | Doug |
| Q2 | Per-hop scoping mechanism: v2 predefined relation `where` filters vs repository rewriting the include tree | REL-2 | decide by spike in REL-2's spec | REL-2 specifier |
| Q3 | YAML shape of the HTTP include allowlist | REL-2 | design in REL-2's spec | REL-2 specifier |
| Q4 | Metric catalog home: YAML vs consuming adapter | SEM-1 | **Decided by default at SEM-1 (#590)** per this recommendation — YAML for atomic tags + pure composites, adapter for data-driven — and built. Recorded in ADR-045 §Decision 7. Reversing it now means moving the composite metric schema out of the entity YAML. | Doug (confirm) |

## 8. Risks

| Risk | Signal | Response |
|---|---|---|
| Drizzle 1.0 changes between rc.4 and GA | a gate fails after a pin move | pins are exact in harnesses; re-run gates on each RC; DRZ-2's spec records the API surface we depend on |
| Per-hop scoping cannot be expressed cleanly in RQBv2 | REL-2 spike | fall back to include-tree rewriting in the repository; if neither is sound, traversal stays internal-only until it is — never ship unscoped hops (I3) |
| A scope leak through traversal | — | leak tests at depth ≥ 3 are exit criteria for #580; `gate:human` on TEN-1 and REL-2 |
| query-surface not published when SEM-2 is ready | query-surface#40 still open | documented fallback: vendored type mirror + conformance test (PLAN §5.3) |
| Snapshot churn hides real regressions | large baseline diffs | DRZ-1 isolates the mechanical churn; every later PR explains each snapshot class it changes |
| Plan drift — docs stop matching reality | a spec contradicts this charter | §9 protocol; the checkpoint after DRZ-2; any agent that finds drift fixes it in the same PR |

## 9. Keeping this project current — the protocol

**Principle: the repo holds intent, the tracker holds state, and each fact lives in exactly one place.**

| What | Lives in | Updated by | When |
|---|---|---|---|
| Goal, invariants, decisions, risks | **this file** | whoever makes/learns the change | same PR as the change; decisions also get an ADR |
| Per-unit technical plan | `PLAN.md` | implementer / specifier | when a landed PR changes what a *later* unit must do |
| Per-issue how | `docs/specs/<KEY>.md` (`DRZ-1.md`, `REL-2.md`, …) | specifier at `/design`; implementer at merge | written at design; corrected to **post-implementation truth** in the implementing PR |
| Durable why | `docs/adrs/` | decision-maker | append-only; dated revision notes |
| Current state of the project | **issue #578 body** (dashboard) | the agent that closes an epic or runs a checkpoint | edited **in place** — it is a snapshot, not a history |
| History of the project | **comments on #578** | same | one dated entry per checkpoint / epic close / decision |
| Current state of an epic | **epic issue body** (goal, exit criteria, task table, "what downstream must know") | the agent that merges a task in that epic | edited in place at each task merge |
| History of an epic | **comments on the epic** | same | one entry per merged task (template below) |
| Task stage | labels `state:*` + board Status | `/design`, `/develop`, humans | at each transition |

Issue bodies link to repo docs by path on `main`; they do not copy them. If a body and a repo doc disagree, the repo
doc wins and the body gets fixed.

### Epic log entry (posted on the epic when a task merges)

```
### <KEY> merged — <date> — PR #<n>
**Shipped:** one or two lines.
**Differs from plan:** what the spec/PLAN said vs what was built (or "nothing").
**Downstream must know:** concrete facts later tasks depend on (names, paths, APIs, limits discovered).
**Docs updated:** spec ✔ / PLAN § / charter § / ADR — or "none needed".
**New risks / follow-ups:** issues filed, or "none".
```

### Project log entry (posted on #578 at a checkpoint, epic close, or decision)

```
### <Checkpoint | Epic #n closed | Decision> — <date>
**State:** what is done / in flight / next.
**Changed since last entry:** decisions, plan revisions, risks.
**Focus now:** the one thing that matters next.
```

### Definition of done for every task

1. Gates green with no filtered error classes (I9), output from the run after the last edit.
2. Spec corrected to post-implementation truth; open questions it resolved are closed here (§7) too.
3. Epic body + epic log entry updated; board Status moved.
4. If anything learned changes a later unit: `PLAN.md` (and this file if it touches §1–§6) updated in the same PR.

## 10. Glossary

- **Include tree** — the nested `with:` object RQBv2 resolves from one root in one statement.
- **Hop** — one level of an include tree; one relationship edge crossed.
- **Navigator** — generated, typed builder on a service (`from(id).rel().rel().fetch()`) that compiles to an include tree.
- **Declared model** — an `AggregateModel` built from YAML, as opposed to one recovered by introspecting Drizzle.
- **Capability** — an ADR-041 pattern kind contributing a mixin/forwarders; composes over a single **spine** (the
  config-bearing base pattern).
- **Role** — a named, typed edge from a communication-style entity to an actor entity (`host`, `attendees`); becomes
  the v2 relation `alias`.
