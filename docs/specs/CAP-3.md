# CAP-3 — `Actor` + `Communication`: library capabilities and their runtime mixins

**Status:** Draft
**Date:** 2026-09-17
**Issue:** #595 · **Epic:** #582 · **Project:** #578
**Depends on:** CAP-1 (#593), CAP-2 (#594)
**Governed by:** `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` (charter) · PLAN §6.4–6.5 ·
ADR-041 (+ its 2026-09-17 revision note) · `docs/specs/CAP-1.md` and `docs/specs/CAP-2.md`, each §"What downstream
must know" · ADR-041.1 (written in this PR)

## Why

CAP-1 made capabilities emit; CAP-2 made roles declarable. Neither made them *do* anything. The capability fixture
still declares `Actor` and `Communication` as mixin-only stand-ins in the consumer project, and a meeting with a
`host`, `attendees` and an `about` has no way to answer the two questions a role block exists for:

- **which meetings did this contact attend / host?** — `findByRole(role, actorId)`
- **who took part in this meeting, and in what role?** — `participants(id)`

and an actor entity has no way to say whether it is one person or a group of them. CAP-3 ships both capabilities
in the library, with runtime mixins that answer those questions in one scoped statement each.

## Charter invariants this PR touches

- **I1 declare once.** The `roles:` block is the only declaration of a role. `communicationConfig` is *emitted* from
  it (never authored), and the one-role column comes from the same `clpBelongsTo` entry that emits the FK — no
  second derivation of `<role>_<target>_id`. `Actor`'s `members:` names an existing `has_many` relationship; the
  member table and FK are read from that declaration, not restated.
- **I2 generated means regenerated.** Both configs are `@generated` literals on the repository; the mixins live in
  the runtime. No author seam.
- **I3 scope at the repository, ALS-fed.** No capability method takes a scope parameter. Every read runs through
  the repository's own `baseQuery()` / `scopeAnd()`, so tenant (`userTracking` + the ALS requester) and soft-delete
  apply to the root. The integration test proves a second scope sees nothing.
- **I4 a traversal is one statement.** `findByRole` is one `SELECT` (a many-role is an `EXISTS` over the junction
  inside the scoped `WHERE`); `participants` is one `UNION ALL`. No second query, no per-role round-trip.
- **I7 no backwards compat.** The CAP-2 stand-ins are deleted, not kept beside the library ones. An app pattern
  that reuses a library pattern's name becomes a registration error instead of a silent shadow.
- **I9 honest gates.** The #624 named expectation is untouched (CAP-3 generates nothing new in package mode that it
  covers); no filter is added.
- **I11 scope discipline.** clean-lite-ps only.

## Measured before deciding

| # | Question | Measurement | Result |
|---|---|---|---|
| M1 | Does the many-role need a lazy table reference to avoid an import cycle? | Generated the CAP-2 fixture (`KEEP_SMOKE_DIR=1`) and traced imports: `meeting.repository` → `meeting_contact.entity` → `meeting.entity` / `contact.entity`. Nothing imports a repository back. | **No cycle.** A live handle (`table: meetingContacts`) is typed and needs no thunk — the same thing `integrationConfig.fkResolvers` already emits. |
| M2 | Can `findByRole`'s `role` parameter be typed to the declared role names? | Spiked `role: RoleName<NonNullable<this['communicationConfig']>>` in the kept project. | **TS4105** — a protected member cannot be indexed on a type parameter; making the config public would break CAP-1's `protected override` hand-off for every capability. `role: string`, validated at runtime with a named error. |
| M3 | Do `exists(...)` and `unionAll` over the widened `tableRef` compile inside a mixin against drizzle 1.0.0-rc.4? | Same spike, `tsc --noEmit` in the kept vendored project. | **Clean.** |
| M4 | What does the registry do with an app pattern named like a library one? | Read `src/patterns/registry.ts`: `getPattern()` checks `APP_PATTERNS` first; `loadAppPatterns()` checks duplicates only within `APP_PATTERNS`. | **Silent shadow**, as CAP-2 recorded. |

## Design

### 1. Library definitions

`src/patterns/library/actor.pattern.ts` and `communication.pattern.ts`, both `defineCapabilityPattern()`, registered
in the library barrel. Names are the CAP-2 constants (`ACTOR_CAPABILITY`, `COMMUNICATION_CAPABILITY`) — imported,
not retyped.

| | `Actor` | `Communication` |
|---|---|---|
| `mixin` / `mixinImport` | `WithActor` / `@shared/base-classes/with-actor` | `WithCommunication` / `@shared/base-classes/with-communication` |
| `forwarderMethods` | none (see §5) | `['findByRole', 'participants']` |
| `configSchema` | `{ kind: 'individual' \| 'group', members?: string }`, `.strict()`; `members` required for `group`, rejected for `individual` | none — the author writes `roles:`, not `config:` |
| `configProperty` | `actorConfig` (the default) | `communicationConfig` (the default) |

`mixinImport` is authored `@shared/…` and rewritten to `@pattern-stack/codegen/runtime/base-classes/…` in package
mode by the existing `rewriteSharedImport` path — the same route `WithAnalytics` and every spine base take.

### 2. The emitted configs — resolved, not copied

CAP-1's config hand-off renders the author's `config:` block verbatim. Both CAP-3 capabilities need codegen to
*resolve* names to tables and columns, so the clean-lite-ps prompt gains one resolver per library capability
(`resolveCapabilityConfigs` in `src/roles/capability-config.ts` — dependency-free like `derive.ts`, so the prompt
can import it). Output lands in the existing `capabilityMixins[].config` slot, plus a list of table imports the
repository template emits. A value that is a table handle is marked so `renderPatternConfigLiteral` writes it as an
identifier rather than a string.

**`Communication`** — from `clpBelongsTo.filter(r => r.role)` (one-roles; the column is that entry's `camelField`,
so the FK derivation stays CAP-2's) plus `definition.roles` for many-roles:

```ts
protected override readonly communicationConfig = {
  roles: {
    host:      { cardinality: 'one',  target: 'contact', column: 'hostContactId' },
    about:     { cardinality: 'one',  target: 'account', column: 'aboutAccountId' },
    attendees: { cardinality: 'many', target: 'contact',
                 via: { table: meetingContacts, self: 'meetingId', target: 'contactId' } },
  },
} as const;
```

The junction's table identifier, file and column names follow `junction new`'s rules
(`pluralize(<via>)` → camelCase export, `modules/<plural>/<via>.entity`, `<entity>_id` columns); the import path is
computed relative to the repository's own folder so a `context:`-nested entity still resolves.

**`Actor`** — `individual` emits `{ kind: 'individual' }`. `group` resolves `members:` against the entity's
`relationships:`; it must name a `has_many`, whose `target` and `foreign_key` give the member table and column:

```ts
protected override readonly actorConfig = {
  kind: 'group',
  members: { table: contacts, foreignKey: 'accountId' },
} as const;
```

Both are **generation errors** when wrong (the ADR-041 §4 posture): `Actor` without a `config:` block, a config the
schema rejects, or `members:` naming something that is not a `has_many`. The schema rules are also reported by
`validatePatternComposition` (it already safe-parses every `configSchema`); the `members:` → `has_many` rule is
per-entity, so it goes there too.

### 3. `WithCommunication`

```ts
export function WithCommunication<TBase extends RepositoryCtor>(Base: TBase) {
  abstract class CommunicationMixin extends Base {
    protected readonly communicationConfig?: CommunicationConfig;
    findByRole(role: string, actorId: string): Promise<Array<EntityOf<TBase>>>;
    participants(id: string): Promise<Participant[]>;
    protected rolePredicate(role: string, actorId: string): SQL;
  }
}
```

- **`findByRole`** — `this.baseQuery(this.rolePredicate(role, actorId))`. A one-role is `eq(col, actorId)`; a
  many-role is `EXISTS (SELECT 1 FROM <junction> WHERE <junction>.<self> = <this>.id AND <junction>.<target> =
  actorId)`. One statement, the repository's own scope around it. An undeclared role throws, naming the repository
  and the declared roles.
- **`participants(id)`** → `Array<{ role: string; target: string; id: string }>`, **ids only**, one `UNION ALL`:
  a one-role branch reads the FK from this table under `scopeAnd` (null FKs skipped); a many-role branch reads the
  junction `INNER JOIN` this table under `scopeAnd`. So a row the caller's scope cannot see contributes nothing from
  any branch. Hydration is **out of scope**: role targets are different entities, and REL-2's typed includes are the
  hydration path — a second hydration mechanism here would be the thing I4 forbids.
- The generated service's `host(meetingId)` / `about(meetingId)` (CAP-2 keyed one-role relations by role name) are
  untouched; `findByRole` is the inverse direction and does not re-emit them.

### 4. `WithActor`

`memberPredicate(actorId): SQL` — a predicate over **this** table: "this row is, or contains, actor `actorId`".

- `individual` → `eq(this.id, actorId)` — the identity predicate.
- `group` → `EXISTS (SELECT 1 FROM <members.table> WHERE <members>.<foreignKey> = <this>.id AND <members>.id =
  actorId)` — "the groups actor X belongs to".

Why over this table and not over the member table: a predicate over *this* table composes into this repository's
own scoped `baseQuery` / `list({ where })`, so I3 holds by construction. A predicate over the member table would
only be usable by another repository (cross-repository composition, which I4 rules out) and would carry none of the
member entity's scope. The member hop is a membership test on the FK — it returns no member rows (see Risks).

### 5. Service forwarders

`Communication` forwards `findByRole` and `participants`. `Actor` forwards nothing: `memberPredicate` returns a
Drizzle `SQL` fragment, which is repository vocabulary and must not become a service method.

### 6. Library/app name shadowing — now a registration error

`loadAppPatterns()` already treats two app patterns of one name as a load error ("Pattern names must be unique").
CAP-3 applies the same rule across the library boundary: an app `domain`/`capability` pattern whose name is a
library pattern's is **not registered**, and the loader returns an error naming both. `getPattern()`'s app-first
lookup then has nothing to shadow; its doc comment stops advertising shadowing. No override flag (I7).

### 7. Fixture

`test/smoke/fixtures/capability/`:

| Entity | `patterns:` | Change |
|---|---|---|
| `meeting` | `[Activity, Communication]` | unchanged roles; now the **library** `Communication`. PLAN §6.4 / #595's `[Integrated, Activity, Communication]` has two spines and does not generate (CAP-1) — ADR-041 §5 says not to dual-author `Activity` as a capability until a consumer needs it, and CAP-3's acceptance does not. |
| `contact` | `[Actor]` | `config: { Actor: { kind: individual } }` — still CAP-1's single-capability inline case |
| `account` | `[Group, Integrated, Individual, Audited, Actor]` | `config: { Actor: { kind: group, members: contacts } }` + a `has_many contacts` relationship |

Deleted: the `ActorPattern` / `CommunicationPattern` stand-ins and `with-actor.ts` / `with-communication.ts`.
`Group` / `Individual` / `Audited` / `Colliding` stay — they are the app-capability path. New assertions: library
mixin imports in both modes, both config literals, the `findByRole` / `participants` forwarders, no `memberPredicate`
forwarder.

### 8. Integration

A new scaffold suite (`test/scaffold/tests/communication-actor.test.ts`) on the scaffold's precedent — test repos
extending the **real runtime** bases with the config shape codegen emits (the smoke proves the generated literal
type-checks against the mixin; this proves the SQL). Tables `cap_contacts`, `cap_accounts`, `cap_meetings`,
`cap_meeting_contacts` in `test/scaffold/schema.ts`; the meeting repo is `userTracking` + `scopeEnforcement: 'strict'`
over the `Activity` spine:

- `findByRole('attendees', contactId)` returns the meeting (many-role, junction `EXISTS`);
- `findByRole('host', contactId)` returns the meeting (one-role);
- `participants(meetingId)` returns host, about and both attendees;
- under a **second** `withUserScope`, all three return nothing (I3);
- an undeclared role throws;
- `memberPredicate`: group → the account containing the contact; individual → identity.

### 9. ADR-041.1

`docs/adrs/ADR-041.1-roles-and-actor-communication.md`: `roles:` and the two library capabilities as ADR-041's
first library consumers; the resolved-config hand-off; the shadowing rule; the `participants` shape; why
`memberPredicate` is over its own table.

## Out of scope

- Typed role-name parameters (M2), hydration in `participants` (REL-2), a `Group`→`Individual` expansion predicate
  over the member table (see §4).
- Authoring `Activity` as a capability (ADR-041 §5).
- `to_shape`, selector catalog, shape registry; `Activity` subject semantics; the `clean` pipeline (#602).
- Member-side scope inside `memberPredicate`'s `EXISTS` (see Risks).

## Risks

| Risk | Signal | Response |
|---|---|---|
| The member hop in `memberPredicate` ignores the member entity's soft-delete / tenant scope | a soft-deleted contact still makes its account match | Recorded, not hidden: the fragment tests FK membership and returns no member rows. Scoping a hop by another entity's behaviors needs that entity's declaration at emit time, which the one-YAML prompt does not have; REL-2's include tree is where per-hop scope lands. |
| The junction naming rule is restated in the resolver | a junction rename breaks the import | The smoke's `tsc` leg compiles the import in both modes; the rule has no YAML override (CAP-2 §4). |
| A library pattern name now collides with a project's own | load error on upgrade | Intended (I7). The message names the library pattern. |

## Acceptance

- `bun run typecheck && bun run build && bun run test` · `just test-all` · `just test-integration` ·
  `just test-post-publish` (runtime base-classes change) · `just test-smoke-junction-clean` stays exactly 118.
- No new `any` beyond the mixin idiom, no `as unknown as`, no filter, no `.skip`.

## What downstream must know

_Filled in at implementation._
