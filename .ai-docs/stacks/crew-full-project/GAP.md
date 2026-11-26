# Gap: what codegen-patterns needs to generate crew as a full codegen project

Slice s9, research, read-only. 2026-11-26. Brief: `docs/BRIEF-gap-crew-vs-codegen.md`.

Read against:
- **codegen**: `checkouts/codegen-patterns/main` at `c6f7e222` (pulled; up to date). Paths starting `cg:` are relative
  to it.
- **crew**: `~/Farm/crew/checkouts/crew/main` at `a73f330`. Paths starting `crew:` are relative to it.

I read crew myself. Three read-only agents mapped codegen's YAML schema, its repository, events and tests, and its jobs
subsystem. I checked their key claims at the cited lines before using them. Line numbers are measured. Sizes and
anything marked *guess* are estimates.

## The answer

Codegen can generate crew's **storage layer**, but not today, and not much above it. Crew's application layer is
almost all policy.

Generating storage needs eight things in codegen:
1. key shapes other than a uuid `id`;
2. nested value objects and tagged unions spread over columns;
3. `rev` compare-and-set;
4. guarded "set once" updates;
5. declared counts and `IS NULL` / `IN` / range filters;
6. a Zod 4 record schema where a null column reads as a *missing* field;
7. a store bound to one transaction, bundling a module's nouns;
8. emitted SQLite DDL and conformance suites.

Of crew's 36 repository methods:
- 17 map onto codegen's standard API once keys are fixed;
- 6 more fit if crew adapts (other names, two calls instead of one);
- 13 need something codegen can't express yet.

Above storage:
- Generated services give crew only its plain reads, 7 of about 40 use-case methods.
- Crew keeps the tree rule, liveness, transitions and refusals by hand, as planned.
- Crew keeps its own events system. Codegen's subscribers run after commit; crew's must run inside the transaction.
- Of codegen's jobs subsystem, crew can reuse the table design, the claim/lease/retry logic and the pure helpers. The
  SQL and the boot sequence must be rewritten for SQLite and plain wiring.

Where crew's module template and codegen's layout disagree is **where files go**, not what they contain:
- generated Zod and repository interfaces are pure, so they fit `domain/`;
- generated Drizzle fits `infrastructure/sqlite/`;
- codegen's per-entity folders and its Nest use cases do not fit at all.

## 1. Nouns: can the entity YAML express them?

Today the YAML describes Postgres tables, each with one uuid `id` (`cg:templates/entity/new/backend/entity.ejs.t:41`).
A declared `fields.id` is silently skipped (`cg:src/derived/columns/fields.ts:62`). Fields are a flat record
(`cg:src/schema/entity-definition.schema.ts:1196`). There is no SQLite target: `target.data` accepts only
`drizzle-pg` (`cg:src/schema/codegen-config.schema.ts:229`).

Legend: ✅ expressible, 🟡 partly, ❌ not.

| Noun (crew file → table) | Keys | Value objects / unions | rev | Other | Verdict |
|---|---|---|---|---|---|
| Team (`crew:src/modules/teams/domain/team.ts`, `teams_team`) | composite PK `(project, id)`, no surrogate (`teams.sql:3-12`) ❌ | `work {system, ref}` → 2 nullable columns, all or none ❌ | none | `state` enum; `closedAt` optional | ❌ (key, value object) |
| Agent (`agent.ts`, `teams_agent`) | `seq` autoincrement PK + `UNIQUE (project, team, agent)` (`teams.sql:14-30`). Unique ✅ (`unique_indexes`, S:1407); autoincrement ❌ | `address` → 3 columns ❌; `parent` stored as the agent name only, sharing project/team with `address` (`sqlite.teams-store.ts:76,107-109`) ❌ | yes ❌ | `refine(lead ⇔ no parent)` (`agent.ts:52-55`): policy, hand-written; `attended` boolean ✅ | ❌ |
| AgentSession (`agent-session.ts`) | `seq` PK + text `id UNIQUE` 🟡 | `agent` address, `runtime {kind, ref}`, `harness {kind, session?}`, `ended {at, reason, detail?}?` ❌ | yes ❌ | — | ❌ |
| AgentNotification (`crew:src/modules/notifications/domain/agent-notification.ts`) | `seq` PK + text `id UNIQUE` 🟡 | `agent` address; `delivered {at, via, session}?` ❌ | none (set-once instead) | 4 enums ✅ | ❌ |
| Message (`crew:src/modules/mail/domain/message.ts`) | `seq` PK + text `id UNIQUE` 🟡 | `from`: union agent / human / crew (`:9-13`); `to`: union agent / room (`message-recipient.ts:16`); both spread over columns (`mail.sql:5-13`) ❌ | none (immutable) | `refs` JSON array of strings (`mail.sql:17`) 🟡; Zod defaults (`refs: []`, `needsAck: false`) | ❌ |
| MessageReceipt (`message-receipt.ts`) | `seq` PK + `UNIQUE (message, project, team, agent)` 🟡 | `to` address; `refusal {reason, detail}?`; `at {queued?, delivered?, …}` (5 optional instants) ❌ | yes ❌ | — | ❌ |
| Room (`room.ts`) | `seq` PK + `UNIQUE (project, team, room)` 🟡 | `address`; `openedBy`: sender union ❌ | none | — | ❌ |
| RoomMember (read cursor) (`room-member.ts`) | `seq` PK + `UNIQUE (project, team, room, agent)` 🟡 | `room` and `agent` addresses **share** project/team; the store refuses a mismatch (`assert-mail-repositories.ts:192`) ❌ | yes ❌ | `readThrough?`, `readAt?` | ❌ |
| Project (`project.ts`) | not stored (folders) | — | — | — | n/a |
| AgentVitals (`crew:src/modules/vitals/`) | derived, nothing stored | — | — | "missing, never 0" (`vitals.protocol.ts:4`) | n/a |

Crew conventions that cross every noun:

| Convention | Crew | Codegen today | Gap? |
|---|---|---|---|
| Missing vs null | a null column reads as a **missing** field (`present()`, `sqlite.teams-store.ts:54-56`); the conformance suite checks a move can clear an optional (`assert-teams-repositories.ts:99-107`) | output DTOs are `.nullable()` (`cg:test/baseline/…/contacts/dto/contact-output.dto.ts:6-20`) | yes (G3) |
| Instants | `Instant = z.iso.datetime({offset: true})` strings (`crew:src/core/kernel/time.ts:4`), stored as TEXT | `z.coerce.date()` (Date objects); `datetime` → `timestamp` (`cg:src/targets/drizzle-pg/columns.ts:23`) | yes, on the plain/sqlite target (G3) |
| Optional without default | leave it out | supported: neither `required` nor `nullable` → NULL (`cg:src/schema/field-nullability.ts:1-14`) | no |
| Enums | TEXT, no CHECK | `pgEnum`; #785 plans text + CHECK | covered by TGT-2a / #785 |
| Booleans | INTEGER 0/1 | `boolean` | covered by TGT-2a (`integer({mode:'boolean'})`) |
| Timestamps behaviour | none (crew's own `openedAt` and similar) | opt-in `behaviors: [timestamps]` (S:1208) | no |
| Rows checked on the way out | `X.parse(row)` in every store | none (Drizzle rows returned as typed) | yes (G3) |
| Cross-module foreign keys | none: references are values (a receipt holds an address, not an FK) | `belongs_to` makes uuid FKs | no: crew declares no cross-module `belongs_to` |

### YAML sketches (proposed syntax, nothing like it exists)

```yaml
# teams/team.yaml
entity: team
module: teams                       # G8: groups nouns into a crew module
table: teams_team
key: [project, id]                  # G1: composite natural PK, no uuid id, no seq
fields:
  project: { type: name, required: true }   # a `name` scalar, or `string` + a Zod refinement hook
  id:      { type: name, required: true }
  work:    { shape: { system: string(1..64), ref: string(1..256) }, optional: true }   # G2: columns work_system, work_ref; all or none
  state:   { type: enum, choices: [open, closed], required: true }
  opened_at: { type: instant, required: true }   # G3: ISO string, TEXT on sqlite
  closed_at: { type: instant }
```

```yaml
# teams/agent.yaml
entity: agent
module: teams
table: teams_agent
order: seq                          # G1: autoincrement ordering column (the PK on sqlite)
key: address                        # G1: the identity every get / move uses (unique)
fields:
  address: { shape: agent_address, required: true }   # G2: a named shape, declared once (project, team, agent)
  role:    { type: name, required: true }
  level:   { type: enum, choices: [lead, coordinator, worker], required: true }
  parent:  { shape: agent_address }                    # crew adapts: 3 columns, not a name sharing address's columns
  state:   { type: enum, choices: [ready, live, refreshing, down, retired], required: true }
  state_since: { type: instant, required: true }
  session: { type: id }
  attended: { type: boolean, required: true }
  opened_at: { type: instant, required: true }
  retired_at: { type: instant }
versioned: rev                      # G4: compare-and-set column, starts at 0; emits move(next)
queries:
  - { by: [address.project, address.team], order: seq }       # onTeam
```

```yaml
# mail/message.yaml (the union part)
fields:
  from:
    union: kind                     # G2: tagged union spread over columns
    variants:
      agent: { agent: agent_address }     # → from_kind, from_project, from_team, from_agent
      human: { name: name }               # → from_human
      crew:  {}
  refs: { type: json, of: "string[]", default: [] }   # G3: a typed JSON column
```

```yaml
# notifications/agent_notification.yaml (the set-once part)
fields:
  delivered: { shape: { at: instant, via: [pull, inject], session: id } }
updates:                            # G5: guarded updates, named
  - { name: deliver, set: [delivered], where: { delivered: missing } }   # returns the row, or undefined
  - { name: retell,  set: [subject],   where: { delivered: missing } }
queries:
  - { name: pending, by: [agent], where: { delivered: missing }, order: seq, limit: true }   # G6
  - { name: pendingCount, by: [agent], where: { delivered: missing }, count: true }        # G6
```

## 2. Repository methods

Codegen's standard API (verified): `findById → row | null`, `findByIds`, `list({where: (t)=>SQL, sort, limit,
offset})`, `count(where?)`, `exists`, `create → row`, `update(id, patch) → rows[0]` (an `undefined` typed as the
entity when nothing matched), `delete`, `upsertMany` (one INSERT per row)
(`cg:runtime/base-classes/base-repository.ts:346-505`). On top of those it adds declared finders, equality AND on
columns with `unique` and `order` (S:835-842), named `findBy<A>And<B>` (`cg:src/derived/api/names.ts:163-168`).
`limit: true` is computed (`entity-locals.js:1096`) and **read by no template**: a no-op.

`list` and `count` take a Drizzle callback, which crew's application layer can't build (it imports zod only, §7). So
on the plain target, only **declared** queries count as the standard.

Classes: **std** = maps onto the standard once G1 lands; **adapt** = crew rewrites its call; **gap** = codegen can't
express it safely.

| Module.repo | Method (crew file) | SQL today | Codegen standard equivalent | Class |
|---|---|---|---|---|
| teams.teams | `get(key)` (`team.repository.ts:8`) | PK lookup | `findById` on the composite key | std (G1) |
| teams.teams | `add(team)` rejects a duplicate | INSERT | `create`; a duplicate throws the raw driver error, and crew's suite only checks that it rejects | std |
| teams.agents | `get(address)` | unique lookup | unique finder on the key | std (G1, G2) |
| teams.agents | `onTeam(team)` oldest first | `… ORDER BY seq` | `queries: {by: [project, team], order: seq}` → `findByProjectAndTeam` | adapt (name) |
| teams.agents | `add` (rev 0) | INSERT | `create` | std (G4 sets rev 0) |
| teams.agents | `move(next)` → row or undefined | `UPDATE … WHERE key AND rev = ?` (`sqlite.teams-store.ts:186-198`) | none: `update` matches on `id` only (`base-repository.ts:467`); `versionable` is "Future" (`cg:src/behaviors/index.ts:214`) | **gap** G4 |
| teams.sessions | `get(id)`, `add` | unique id | `findById`, `create` | std (G1) |
| teams.sessions | `ofAgent(agent, limit)` newest first | `ORDER BY seq DESC LIMIT ?` | finder with `order: "seq desc"`, but `limit` is a no-op | **gap** G6 (small) |
| teams.sessions | `move` | CAS | — | **gap** G4 |
| notifications | `get`, `add` | | `findById`, `create` | std |
| notifications | `pending(agent, limit)` | `AND delivered_at IS NULL ORDER BY seq LIMIT` | no null predicate or limit on finders | **gap** G6 |
| notifications | `pendingCount(agent)` | `count(*) … IS NULL` | `count(where)` needs Drizzle; no declared count | **gap** G6 |
| notifications | `bySource(agent, source)` | equality, `ORDER BY seq` | `findByAgentAndSource` | adapt (name) |
| notifications | `deliver(id, d)` set once | `UPDATE … WHERE id AND delivered_at IS NULL` (`sqlite.notifications-store.ts:101-110`) | none | **gap** G5 |
| notifications | `retell(id, subject)` | same guard | none | **gap** G5 |
| notifications | `nudged(id, at)` | plain UPDATE by id | `update(id, {nudgedAt})` | std |
| mail.messages | `get`, `add` | | `findById`, `create` | std |
| mail.messages | `position(id)` | `SELECT seq WHERE id` | `queries: {by: [id], select: [seq], unique}` → `findSeqsById` | adapt (name) |
| mail.messages | `inRoom(room, after?, limit)` | `seq > coalesce((SELECT seq …), 0) ORDER BY seq LIMIT` | no range filter on finders (#799 plans ranges for `search` only) | **gap** G6; crew adapts to two calls: `position`, then `seq > n` |
| mail.messages | `countInRoom(room, after, notFrom)` | count with `NOT (from = agent)` | none | **gap** G6; crew adapts to count(after) − count(after, from = me) |
| mail.receipts | `get(message, to)`, `add` | unique `(message, project, team, agent)` | unique finder, `create` | std (G2) |
| mail.receipts | `ofMessage(message)` | equality, `ORDER BY seq` | finder | adapt (name) |
| mail.receipts | `unread(to, limit)` | `state IN ('queued','delivered') … LIMIT` | no IN on finders | **gap** G6 |
| mail.receipts | `unreadCount(to)` | count + IN | none | **gap** G6 |
| mail.receipts | `move` | CAS | — | **gap** G4 |
| mail.rooms | `get`, `add` | unique `(project, team, room)` | unique finder, `create` | std (G2) |
| mail.rooms | `onTeam(team)` | `ORDER BY seq` | finder | adapt (name) |
| mail.members | `get(room, agent)`, `add` | unique; the store refuses an agent on another team | unique finder, `create`; crew moves the team check to the use case or stores 4 columns | std + adapt |
| mail.members | `ofRoom(room)` | `ORDER BY seq` | finder | adapt (name) |
| mail.members | `move` (cursor) | CAS | — | **gap** G4 |

Totals: 17 std, 6 adapt, 13 gap. The gap rows by kind: CAS ×4, set-once ×2, predicates, counts and limits ×7, plus
the key and value-object prerequisites under every row.

Two shapes differ everywhere. Crew can adapt to both cheaply, or the plain target can choose crew's way:
- **Missing row:** crew returns `undefined`; codegen returns `null` (`findById`) or a mistyped `undefined` (`update`).
- **Method names:** crew's are domain words; codegen's are derived. By d9 crew takes the derived names. Only named
  updates (`deliver`, `retell`) need a `name:`.

## 3. Services and use cases

Codegen emits, per entity:
- a service of read forwarders over `BaseService` (`cg:runtime/base-classes/base-service.ts:120-238`);
- 6–9 use cases, mostly one-line pass-throughs (`cg:test/baseline/…/contacts/use-cases/update-contact.use-case.ts`).

Writes fire lifecycle events with `void emitSafely(…)`, without `tx`, and swallow errors
(`base-service.ts:157-165,218`). Every entity file is `force: true` with a "DO NOT EDIT" banner. There are no
protected regions; extending is by app-defined patterns (`cg:docs/adrs/ADR-031-app-defined-patterns.md`) or by
subclassing.

Crew's application layer, method by method:

| Module | Use-case methods (crew file) | Plain plumbing | Policy (hand-written) |
|---|---|---|---|
| teams | 14 (`crew:src/modules/teams/application/teams.protocol.ts:31-62`) | `sessions`, `session`, `onTeam` (reads, `teams.ts:411-413`) | openTeam (refuse if it exists, `team.opened`), open (the tree rule, `domain/tree.ts`), fill/refresh/release/retire/wake (transitions, runtime calls outside transactions, CAS retry as refusal), seen, attend, get/check (liveness layer 1) |
| notifications | about 10 (`notifications.protocol.ts`) | `pending`, `pendingCount` (`notifications.ts:138-139`) | notify (replace one line per source), inject/pull (delivery tiers, `domain/delivery.ts`), the `agent.down` subscriber (`downNotice`), nudges |
| mail | about 12 (`mail.protocol.ts`) | `receipts`, `rooms` (`mail.ts:292,347`) | send (liveness then the tree, `posting-rule.ts`), post (`postProblem`, mentions), read (cursor CAS), the `team.opened` and `notification.delivered` subscribers |
| vitals | 3 (derived) | none | all of it (`vitals.ts`) |

So 7 of about 40 methods are plumbing a generator could hold. What is worth generating is the plumbing *under* the
policy, which every crew use case repeats:
- `reading` / `writing`: `database.read` / `database.transaction` with the store built from the handle
  (`teams.ts:38-40`, `mail.ts:76-77`, `notifications.ts:64-66`);
- the `store: (tx) => create…Store(tx.sql)` factory and `migrate` in `module.ts` (`crew:src/modules/teams/module.ts:10-23`);
- the read forwarders.

How they compose under plain wiring:
- The generated piece is a `<module>.data.ts`-style object: `{ read, write, …readForwarders }` over crew's `Database`
  protocol and the generated `<Module>Repositories`.
- The hand-written `create<Module>(deps)` takes it as a dependency, in place of `store`.
- `module.ts` stays hand-written: it is wiring plus policy dependencies, and it is 25 lines.
- Refusals stay crew's `Outcome` (`refuse(reason, detail, instead)`). The generated layer returns `T | undefined` and
  never throws Nest's `NotFoundException` (the codegen use cases do: `cg:…/use-cases/find-contact-by-id.use-case.ts:28-31`).
- Transition tables stay hand-written (`defineTransitions`). Settled 31 calls state machines model constants, and the
  brief keeps them with crew.

## 4. Transactions and events

| Concern | Crew (Settled 29, d44–d47) | Codegen | Gap |
|---|---|---|---|
| Handle | `database.transaction(async tx => …)`; every statement goes through `tx.sql`; the handle is dead after commit (`crew:src/core/database/database.protocol.ts:33-57`) | `this.db.transaction(tx => …)` in the use case, only when the entity `emits` or uses EAV (`cg:templates/entity/new/backend/use-cases/create.ejs.t:61`); `DrizzleTx = NodePgDatabase` (`cg:runtime/types/drizzle.ts:28`) | the tx type must be a protocol type (G7) |
| Threading | the store is **built from** the handle, so every call is in the transaction, reads included | `tx` is passed explicitly and optionally: use case → service → repository; **reads take no tx** (`base-repository.ts:346-421`); #802 is open | G7 removes the problem: a store bound to the tx has nothing to thread |
| Joining | nested calls in the same async flow join (AsyncLocalStorage in the backend, `crew:src/core/database/backends/sqlite/sqlite.database.ts:7-10,25`) | "join if a tx was passed" (`cg:runtime/base-classes/inheritance.ts:211-217`); no savepoints in either | none: crew's database system does it, below the generated code |
| Separate flows | a queue on one connection, plus `BEGIN IMMEDIATE` across processes | the Postgres pool | none for codegen |
| Drizzle on the handle | needs `SqlHandle.values()` for `sqlite-proxy` (`docs/PLAN-sqlite-drizzle-pair.md`); **not added yet** (`database.protocol.ts:14-22` has run/get/all/exec) | — | crew's call (open) |
| Event append | `append(tx, type, data)` inserts into `events_log` through the tx (`crew:src/core/events/backends/sqlite/sqlite.events.ts:33-44`) | `publish(event, tx?)` inserts into `domain_events` through `tx ?? db` (`cg:runtime/subsystems/events/event-bus.drizzle-backend.ts:276-295`); Postgres table | same idea (an outbox in the tx) |
| Subscribers | run **in the appender's transaction**, in order, before append resolves; a throw rolls it back (`events.protocol.ts:16-27`; proved in `crew:src/core/events/testing/assert-events.ts:35-55`) | Drizzle: **after commit**, from a poll with `FOR UPDATE SKIP LOCKED`; errors logged and dropped, never retried (`event-bus.drizzle-backend.ts:617-624,665-675`). Memory backend: dispatches inside `publish` and rethrows (`event-bus.memory-backend.ts:323-344`), so the two backends differ | crew keeps `core/events` (68 lines); codegen's subsystem isn't needed |
| Lifecycle events | none implicit; every event is explicit and typed (`domain/agent-down.ts`, `team-opened.ts`) | `BaseService` fires `<entity>.created`/`.updated`/`.deleted` outside the tx | the plain target turns them off (G11) |
| Typed events | a `TYPE` constant plus a Zod schema per event, in `domain/` | `events/*.yaml` → `generated/{types,schemas,registry,bus}.ts`; validation only warns (`cg:src/cli/shared/event-codegen-generator.ts`) | small: emit crew's per-event file shape (G12) |

## 5. Tests (d10)

**Codegen emits no tests for a consumer.** No template under `cg:templates/` contains `describe(`, `.spec` or `.test`.
`runtime/` ships no conformance suites.

Codegen's own tests run against Docker Postgres:
- `cg:test/scaffold/tests/repository.test.ts:53-266` covers the CRUD round trip, `null` for a missing row, `count`,
  soft delete, and that a missed update returns `undefined`;
- `event-bus.test.ts` covers rollback leaving no event.

None of them test races or compare-and-set.

What crew's suites check, and whether codegen could emit the check from the YAML:

| Crew check (file:line) | Derivable from YAML? |
|---|---|
| reads back as written, deep-equal ignoring key order (`assert-teams-repositories.ts:52`) | yes: one fixture record per noun |
| a missing key reads as `undefined` (`:53`) | yes |
| a duplicate `add` rejects (`:55,83,123`) | yes (from `key`) |
| a declared order holds: oldest first, newest first (`:84-90,124-130`) | yes (from `order`) |
| a move at the current rev stores rev + 1; a stale rev returns `undefined`; a refused move changes nothing (`:93-98`) | yes (from `versioned`) |
| a move can clear an optional field ("missing never null") (`:99-107`) | yes (from the optional fields) |
| a set-once update can't happen twice and doesn't change the first (`assert-notifications-repositories.ts:78-95`) | yes (from `updates: where`) |
| a count is right; a limit is respected; another agent's or team's rows don't show (`assert-mail-repositories.ts:92-99,146,172`) | yes, given fixtures on two scopes |
| a later post has a larger position (`:177`) | yes (`order` column) |
| a subscriber that throws rolls the transaction back | **not a repository check**: it lives in `assert-events.ts`, crew's system |
| real races (two flows) | crew's suites don't test these either; the stale-rev check is sequential |

So codegen can match crew's suites **if** the YAML carries keys, order, `versioned`, guarded updates and scopes. Codegen
needs:
- a template for `domain/testing/assert-<module>-repositories.ts` taking `within(fn)`;
- a fixture generator that makes valid records from field facts, two per scope;
- the 15-line runner on `:memory:` (`crew:src/modules/teams/__tests__/infrastructure/sqlite/sqlite.teams-store.test.ts`).

That is G10. Fixture values for constrained scalars (crew's `Name` regex, `Instant`) are the fiddly part (*guess*: they
need an example value per scalar type in the YAML).

## 6. Jobs

Crew has **no jobs system yet**: `crew:src/core/` has clock, database, events, harness, kernel and runtime. DESIGN
"Open: running jobs" proposes a runner per project. Codegen's jobs subsystem, piece by piece (paths under
`cg:runtime/subsystems/jobs/`):

| Piece | Nest-bound | Postgres-bound | Reuse for crew's runner |
|---|---|---|---|
| Tables `job`, `job_run`, `job_step` (`job-orchestration.schema.ts`) | no | yes: `pgEnum` ×8, `jsonb`, `uuid`, `timestamptz` (`:13-23,47-95`) | **with changes**: a sqlite-core twin (text + CHECK, `text({mode:'json'})`, ids are already client-made) |
| Protocols `IJobOrchestrator`, run and step services | no | the types name pg rows | nearly as-is |
| `computeBackoff`, `classifyError`, key templates, `pool-config.ts`, keyset cursor, errors | no | no | **as-is**: lift into a Nest-free entry |
| Handler base, `@JobHandler`, registry (`job-handler.base.ts:175-234`) | `Reflect.defineMetadata` needs `reflect-metadata` | no | with changes: a plain `register(type, handler)` beside the decorator |
| `DrizzleJobOrchestrator` (start, cancel, replay, upsert job rows) | decorators only | `onConflictDoUpdate` with `EXCLUDED.*`, `now()`, `::text`, `IS DISTINCT FROM` (`job-orchestrator.drizzle-backend.ts:530-561`) | with changes: rewrite the upsert |
| `JobWorker` claim, heartbeat lease, stale sweep, retry with `run_at = now + delay`, steps | `ModuleRef.get` for handlers (`job-worker.ts:673`), shimmable | `FOR UPDATE SKIP LOCKED` (`:526,564`), `db.execute` (`:873`) | **logic yes, SQL no**: claim becomes one `UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING *` |
| Boot sequence (registry snapshot → upsert → one worker per pool) (`job-worker.module.ts:197-293`) | yes (`onModuleInit`) | no | rewrite as a plain `start()` / `stop()` |
| `pg-notify.ts`, BullMQ backend, the `NestFactory` worker template | yes / yes | yes | no |
| Recurring work: `EventScheduler` (in the events subsystem, `every:` only, no cron) | lifecycle in `events.module.ts:216-227` | `ON CONFLICT` over a `metadata->>` index | no: crew needs its own tick |

Caveat: `timeoutMs` is stored but never enforced. Dedupe is read-then-insert with no unique index. Both are safe on
crew's single serialized writer and racy on Postgres. Source: the jobs agent's reading. I spot-checked only the SQL
lines above.

## 7. Architecture fit (crew's module template, `crew:scripts/architecture.ts`)

The rules that matter here:
- `domain/` and `application/` import zod only, with no Bun or Node globals and no clock or randomness
  (`architecture.ts:296,320`);
- a stateful module must have `infrastructure/sqlite/<module>.sql` and `sqlite.<module>-store.ts`, and
  `domain/testing/assert-<module>-repositories.ts` (`:43-53`);
- modules import each other only through `index.ts`, and there are no cycles (`crew:src/core/kernel/wiring/wiring.ts:81-82`).

| Generated artifact | Where it would sit in crew | Fit |
|---|---|---|
| Zod 4 record schema per noun | `domain/<noun>.record.ts` (generated), re-exported by the hand-written `domain/<noun>.ts`, which adds `.refine` and the transitions | **agrees** (zod only). Needs the Zod 4 emit (s3 follow-up) and G3. *Guess*: the audit accepts an extra file in `domain/` (it names required files, not a closed list, `:491-520`) |
| Repository interfaces + `<Module>Repositories` bundle | `domain/<noun>.repository.ts` (type-only) | **agrees** |
| Drizzle tables (`sqliteTable`) + store `createSqlite<Module>Store(sql)` | `infrastructure/sqlite/sqlite.<module>-store.ts`, plus a tables file beside it | **agrees** with the naming rule (`:510-516`). `drizzle-orm` becomes crew's second dependency (Settled 29, t35) |
| `<module>.sql` DDL | `infrastructure/sqlite/<module>.sql` (required, `:52`) | **gap**: codegen has no DDL or migration output (schema goes through `drizzle-kit push`, `cg:src/cli/commands/dev.ts:40-52`). G9 |
| Conformance suite + runner | `domain/testing/assert-<module>-repositories.ts`; `__tests__/infrastructure/sqlite/…test.ts` | **agrees** once G10 exists |
| Data layer (read/write helpers, read forwarders) | `application/<module>.data.ts` (*guess*: allowed, same reason) | agrees if it imports only types and zod. It must use crew's `Database` protocol, not Drizzle |
| Codegen's Nest use cases (`@Inject(DRIZZLE)`, `NotFoundException`) | none | **conflict**: Drizzle and Nest in `application/` break purity. Not emitted on the plain target |
| Codegen's per-entity folder `modules/<plural>/{entity,repository,service,dto,use-cases,controller,module}` (`modules_dir`, `cg:src/schema/codegen-config.schema.ts:119,158`) | — | **conflict**: crew groups nouns into a module and splits by layer. G8: a module grouping, and output paths per layer |
| Codegen's `module.ts` / `GENERATED_MODULES` barrel | crew's `module.ts` manifest (`defineModule`) | **conflict in kind**. Crew's manifest stays hand-written; it composes generated data plus hand policy |
| `forwardRef` cycles between entity modules (NEST-INTEGRATION §6) | — | **no conflict for crew**: its nouns reference other modules by value, not by FK, so no generated cycle appears. A real conflict for codegen's own Nest projects moving to plain wiring |
| Generated domain importing drizzle | — | would be a conflict, but the split above prevents it: Drizzle only in `infrastructure/` |

Crew's template is a good shape for codegen's plain-wiring target. Where codegen would change: per-module grouping
over per-entity folders, files placed by layer, the store bound to a transaction, and a manifest in place of a Nest
module. Where crew would change: generated `*.record.ts` files beside hand domain files, and its hand suites replaced
by generated ones.

## The gap list

> **2026-11-26, d13:** G1 and G2 are replaced by one feature, value objects. See `PROPOSAL-VALUE-OBJECTS.md`.
> G14 is filed as #948, and the `limit` bug in G6 as #949.

Sizes: S ≈ a day, M ≈ 2–4 days, L ≈ a week or more (*guesses*). "Extends" names the existing issue, epic or slice.

| # | Proposed codegen issue title | Size | Extends |
|---|---|---|---|
| G1 | Key shapes: composite natural primary key, an autoincrement ordering column, and a declared identity (`key:`) that get, update and move use in place of `id` | L | #797 (its natural strategy is single-field; this adds composite), #780, s7 C |
| G2 | Value objects: `shape:` fields stored as prefixed columns (all or none when optional), named shapes reused across entities, and tagged unions spread over a `kind` column plus per-variant columns | L | new, under #783 (no issue covers value objects; #788 `one_of:` is FK-only) |
| G3 | The plain/sqlite record schema: Zod 4 per noun; a nullable column reads as a missing field; `instant` as an ISO string (TEXT); a typed `json` (`of:`); rows parsed on the way out | M | s3 (Zod 4 generated), TGT-2a, #867 (json as `z.record`) |
| G4 | `versioned: rev`: compare-and-set `move(next) → row \| undefined`; `create` starts at 0 | M | the `versionable` behaviour stub (`cg:src/behaviors/index.ts:214`); new under #783. Not #789 (immutable versions) |
| G5 | Guarded updates: named `updates:` with a `where` on current values (set once: `WHERE x IS NULL`), returning `row \| undefined` | M | new, under #783 |
| G6 | Declared queries grow: `name:`, `where` with `missing` / `in` / range (`after:`), `count: true`, and a `limit` that works (today `limit: true` is a no-op, `entity-locals.js:1096`) | M | #799 (extend from `search` to finders); a small bug issue for `limit` |
| G7 | `wiring: plain` store shape: `create<Backend><Module>Store(handle) → <Module>Repositories`, built per transaction on `sqlite-proxy`; reads are in the transaction; a miss returns `undefined` | L | s7 D; #802 (reads in a tx) |
| G8 | Module grouping and layer-placed output: `module:` groups entities; output paths follow crew's template (`domain/`, `application/`, `infrastructure/<backend>/`) | M | the plain-wiring target (codegen-targets d4); #894 (names from the derived surface) |
| G9 | SQLite DDL: emit `<module>.sql` (`CREATE TABLE IF NOT EXISTS`, uniques, indexes) from the same field facts as the Drizzle tables | S–M | TGT-2a (s7 A) |
| G10 | Emitted conformance suites: `assert-<module>-repositories.ts` from keys, order, `versioned`, `updates` and scopes, plus a `:memory:` runner and per-scalar example values | M | new (d10) |
| G11 | Plain data layer: `read` / `write` over a `Database` protocol, read forwarders returning `T \| undefined`, no Nest, no lifecycle events outside the tx | M | plain-wiring target; NEST-INTEGRATION §4 (composition) |
| G12 | Event schema emission in crew's shape: a `TYPE` constant plus a Zod 4 schema per event, in `domain/` | S | EVT-7 typed events |
| G13 | Jobs off Nest and Postgres: sqlite-core tables, a sqlite-proxy job store with a single-statement claim, pure helpers from a Nest-free entry, a plain start/stop runner, and a handler registry without `reflect-metadata` | L | #658 (memory backend has no worker); NEST-INTEGRATION §1 (jobs) |
| G14 | `BaseRepository.update` returns `rows[0]` typed as the entity when nothing matched (`base-repository.ts:458-470`); type it `T \| undefined` or throw | S | bug, standalone; G7 avoids it on the plain target |
| G15 | Typed duplicate-key error (optional: crew's suites only need "rejects") | S | new, optional |

Already queued, and needed by the above: TGT-0b (#941), TGT-1 (s6), ZOD-0 (#945, s3), and on crew's side,
`SqlHandle.values()`.

## Recommended order (merged with the queued slices)

1. **Finish what's in review**: s4 TGT-0b (#941), s6 TGT-1, s3 ZOD-0 (#945). No change.
2. **s7 A, TGT-2a**: the sqlite pair's renderers, **plus G9** (DDL from the same facts) and G3's storage parts
   (`instant` as TEXT, `json` mode, boolean). Its spike test is still the first commit: `sqlite-proxy` over a handle
   with `values()`.
3. **s7 B, TGT-2b**: Postgres typing becomes per pair.
4. **s7 C, YAML growth, widened**: G1 keys, then G4 `versioned`, then G6 queries (with the `limit` fix), then G5 guarded
   updates, then G2 value objects. G1 and G2 are the big ones. G2 can start beside A and B, since it is schema plus
   field facts.
5. **s3 follow-up, Zod 4 in emitted code** (`PLAN-zod4-generated.md`), with **G3**'s record schema.
6. **s7 D, the plain store: G7 + G8 + G10**, one crew module at a time:
   - teams first: needs G1, G2 (address, work, runtime and harness, ended) and G4;
   - then notifications: G5, G6 counts and `missing`;
   - then mail: G6 `in` and ranges, G2 unions.

   Each module is done when the generated suite **and** crew's hand suite both pass on the generated store, in crew's
   `just check`.
7. **The plain-wiring target proper: G11 and G12.** The data layer and event schemas. Lift `wiring.ts` into a package
   once codegen's own non-crew entities use it (NEST-INTEGRATION step 4).
8. **G13 jobs** when crew builds its jobs system (crew's second slice). It needs the sqlite pair (2–3) and G7's
   transaction-bound store.
9. s8 (settings standard) stays independent of all of this.

## Decisions for Doug

1. **Method names.** d9 says crew takes codegen's derived names (`findByProjectAndTeam`, not `onTeam`). Should YAML
   `name:` exist only for named updates (`deliver`, `retell`) and counts, or for every query? Default: only where an
   operation has no column-derived name. This also settles s7's open "D: 1, 2 or 3": it becomes 1 without
   per-finder names.
2. **Value objects (G2): build them, or should crew flatten?** G2 is the largest YAML item and nothing plans it.
   Default: build it, as d9 implies. Columns only (no JSON storage). Crew adapts where two shapes share columns:
   `Agent.parent` stored as three columns, and the room-member team check moved to the use case.
3. **Null vs missing, Date vs ISO string.** Default: per target. The plain/sqlite target gives missing fields and ISO
   instants; `drizzle-pg` keeps `.nullable()` and `Date`, so its goldens stay byte-identical.
4. **Where generated files sit in crew.** Default: `domain/<noun>.record.ts` (generated) beside the hand-written
   `domain/<noun>.ts`; the generated store, tables and `.sql` in `infrastructure/sqlite/`. `module.ts` stays
   hand-written. Does crew's audit need to know about `@generated` files? Default: no.
5. **Tests.** Should the generated conformance suite (G10) replace crew's hand suites once it is at least as strict?
   Default: yes, deleted per module when the generated one passes. Both run in crew's `just check` (crew's s3 lean).
6. **Services.** Doug's "all the way up to services" means, for crew, the data layer (G11): transactions, read
   forwarders, the store. Policy use cases stay hand-written and call it. Confirm that this counts as "services" for
   crew.
7. **Events.** Crew keeps `core/events` (in-transaction subscribers). Codegen's events subsystem is not used; codegen
   emits only event schemas (G12). Confirm.
8. **Jobs (G13).** Is the Nest-free SQLite jobs runtime built **in codegen** (shared, and crew uses it), or does crew
   write a runner on codegen's tables and helpers? Default: in codegen, since the brief asks crew to reuse its DB
   parts.
9. **Still open on crew's side:** `SqlHandle.values()` for `sqlite-proxy` (s7's decision 0). It blocks s7 A's spike.
