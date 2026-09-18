# CAP-3 — `Actor` + `Communication`: library capabilities and their runtime mixins

**Status:** Implemented
**Date:** 2026-09-17 · **Implemented:** 2026-09-17
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
| M2 | Can `findByRole`'s `role` parameter be typed to the declared role names? | Spiked `role: RoleName<NonNullable<this['communicationConfig']>>` in the kept project, config `protected`. Re-measured after M5 made the config public: `role: RoleOf<this>` on the mixin and its surface interface, with `@ts-expect-error` probes on the repository and through a generated-shape service forwarder. | First: **TS4105** (a protected member cannot be indexed on a type parameter). After M5: **works** — `Parameters<MeetingRepository['findByRole']>` resolves `this` to the concrete repository, so the forwarder is typed too. Adopted; the smoke's `tsc` leg now pins it (Found #8). |
| M3 | Do `exists(...)` and `unionAll` over the widened `tableRef` compile inside a mixin against drizzle 1.0.0-rc.4? | Same spike, `tsc --noEmit` in the kept vendored project. | **Clean.** |
| M4 | What does the registry do with an app pattern named like a library one? | Read `src/patterns/registry.ts`: `getPattern()` checks `APP_PATTERNS` first; `loadAppPatterns()` checks duplicates only within `APP_PATTERNS`. | **Silent shadow**, as CAP-2 recorded. |
| M5 | Can a runtime-shipped mixin return its anonymous class (`as TBase & typeof Mixin`, the CAP-1 idiom)? | `bun run typecheck` (`declaration: true` over `runtime/**`). | **TS4094** ×31 — declaration emit cannot name the inherited `protected` members (`table`, `scopeAnd`, …). Consumer-authored mixins compile without declarations and never hit it. See Found #1. |

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
*resolve* names to tables and columns, so the clean-lite-ps prompt gains `resolveLibraryCapabilityConfig(cap, ctx)`
(`templates/entity/new/clean-lite-ps/prompt-extension.js`, exported for tests), keyed on the two CAP-2 name
constants. It lives in the prompt, not in `src/roles`, because its inputs are the prompt's own locals
(`clpBelongsTo`, the module folder, `pluralize`). Output replaces the `capabilityMixins[].config` slot, and the tables
it references become `capabilityConfigImports`, which the repository template emits. A table handle is marked
`identifierRef(name)` (a module-private Symbol key, so no YAML value can impersonate it) so
`renderPatternConfigLiteral` writes it bare. An app capability's config
is still copied verbatim.

**`Communication`** — from `clpBelongsTo.filter(r => r.role)` (one-roles; the column is that entry's `camelField`,
so the FK derivation stays CAP-2's) plus `definition.roles` for many-roles:

```ts
override readonly communicationConfig = {
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
`relationships:`; it must name a `has_many`, whose `foreign_key` gives the column and whose `target` names the
member entity. That entity's table export and module folder come from **its own YAML** (`plural:`, `context:`),
read through `createEntityLookup` (`prompt.js` passes one over `paths.entities_dir`, default `entities`) and
`entityModuleNaming` — the one naming rule, which the entity's own emission also uses. Nothing is re-pluralized at
emit time (Found #9). A self-referential group (`members:` naming a `has_many` back to this entity) uses this
entity's own table and adds no import:

```ts
override readonly actorConfig = {
  kind: 'group',
  members: { table: contacts, foreignKey: 'accountId' },
} as const;
```

Both are **generation errors** when wrong (the ADR-041 §4 posture): `Actor` without a `config:` block, a config the
schema rejects, or `members:` naming something that is not a `has_many`. `validatePatternComposition` reports the
same at validation time: the schema rules through its existing `configSchema` parse (`pattern_config_invalid`), and
the `members:` rule as `actor_members_not_has_many`.

Every capability config, library or app, is emitted **`override readonly`** (public) — see Found #1.

### 3. `WithCommunication`

```ts
export type RoleOf<TRepo> = /* keys of TRepo's communicationConfig.roles, else string */;
export interface CommunicationCapability<TEntity> {
  readonly communicationConfig?: CommunicationConfig;
  findByRole(role: RoleOf<this>, actorId: string): Promise<TEntity[]>;
  participants(id: string): Promise<Participant[]>;
}
export function WithCommunication<TBase extends RepositoryCtor>(
  Base: TBase,
): TBase & CapabilityCtor<CommunicationCapability<EntityOf<TBase>>>;
```

- **`findByRole`** — `role` is `RoleOf<this>`, the keys of the generated `communicationConfig.roles` (a typo is a
  compile error on the repository and through the service forwarder; `string` where the config is not narrowed).
  Body: `this.baseQuery(this.rolePredicate(role, actorId))`. A one-role is `eq(col, actorId)`; a
  many-role is `EXISTS (SELECT 1 FROM <junction> WHERE <junction>.<self> = <this>.id AND <junction>.<target> =
  actorId)`. One statement, the repository's own scope around it. An undeclared role throws, naming the repository
  and the declared roles.
- **`participants(id)`** → `Array<{ role: string; target: string; id: string }>`, **ids only**, one `UNION ALL`
  (every selected field aliased — Found #2):
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
extending the **real runtime** bases (imported by path — Found #4) with the config shape codegen emits (the smoke proves the generated literal
type-checks against the mixin; this proves the SQL). Tables `cap_contacts`, `cap_accounts`, `cap_meetings`,
`cap_meeting_contacts` in `test/scaffold/schema.ts`; the meeting repo is `userTracking` + `scopeEnforcement: 'strict'`
over the `Activity` spine:

- `findByRole('attendees', contactId)` returns the meeting (many-role, junction `EXISTS`);
- `findByRole('host', contactId)` returns the meeting (one-role);
- `participants(meetingId)` returns host, about and both attendees;
- under a **second** `withUserScope`, all three return nothing (I3);
- an undeclared role throws, and a `strict` repository with no ambient scope throws rather than reading unscoped;
- an unset one-role contributes nothing to `participants`;
- `memberPredicate`: group → the account containing the contact; individual → identity.

Unit coverage: `actor-communication-mixins.spec.ts` renders `memberPredicate`'s SQL with `toSQL()` (correlated,
one statement) and pins the error paths; `prompt-extension.test.ts` pins both resolved configs, the context-nested
junction import, the identifier rendering and the three generation errors; `registry.test.ts` pins the
library-name rule; `validate-composition.test.ts` the `members:` rule.

### 9. ADR-041.1

`docs/adrs/ADR-041.1-roles-and-actor-communication.md`: `roles:` and the two library capabilities as ADR-041's
first library consumers; the resolved-config hand-off; the shadowing rule; the `participants` shape; why
`memberPredicate` is over its own table.

## Out of scope

- Hydration in `participants` (REL-2), a `Group`→`Individual` expansion predicate
  over the member table (see §4).
- Authoring `Activity` as a capability (ADR-041 §5).
- `to_shape`, selector catalog, shape registry; `Activity` subject semantics; the `clean` pipeline (#602).
- Member-side scope inside `memberPredicate`'s `EXISTS` (see Risks).

## Risks

| Risk | Signal | Response |
|---|---|---|
| The member hop in `memberPredicate` ignores the member entity's soft-delete / tenant scope | a soft-deleted contact still makes its account match | Recorded, not hidden: the fragment tests FK membership and returns no member rows. Scoping a hop by another entity's behaviors needs that entity's declaration at emit time, which the one-YAML prompt does not have; REL-2's include tree is where per-hop scope lands. |
| The junction naming rule is restated in the resolver | a junction rename breaks the import | The smoke's `tsc` leg compiles the import in both modes. Deriving the junction's table from `pluralize(via)` is safe because `junction new` derives it the same way and a junction YAML has **no `plural:` / `table:` / name override** (its `.strict()` schema rejects them, CAP-2 §4). An *entity* reference, by contrast, is never re-pluralized — a group Actor's member entity is read from its own YAML (Found #9). |
| Pre-existing: a chained `.where()` after `baseQuery()` replaces the scoped predicate in several family-base finders and generated FK methods | out of CAP-3's scope | Tracked as **#616** (fix in PR #619). CAP-3's methods pass their predicate *into* `baseQuery(extra)` / `scopeAnd()` and never chain `.where()`. |
| A library pattern name now collides with a project's own | load error on upgrade | Intended (I7). The message names the library pattern. |

## Found during implementation

1. **Runtime mixins cannot use CAP-1's return idiom (TS4094).** `return Mixin as TBase & typeof Mixin` works for a
   consumer mixin (compiled without declarations) and fails for one in `runtime/` (compiled with `declaration: true`):
   the emitted type would have to name the base's inherited `protected` members. Library mixins now annotate
   `TBase & CapabilityCtor<Surface>` — `CapabilityCtor` is new in `capability-mixin.ts`, next to `RepositoryCtor`,
   with the same mandated `any[]` rest parameter. An interface has no `protected`, so a library mixin's config
   property is **public**, and the repository template now emits every capability config as `override readonly`
   instead of `protected override readonly`. A public override also fills a consumer mixin's `protected`
   declaration (the smoke's `WithGroup` still declares it `protected` and still compiles). One side effect worth
   knowing: `rolePredicate` became `private`, because a `protected` helper cannot be part of the surface.
2. **`UNION ALL` needs aliased raw fields.** The first `participants` passed `tsc` and failed at runtime in
   the integration suite: *"You tried to reference "role" field from a subquery, which is a raw SQL field, but it
   doesn't have an alias declared"*. Every branch field is now `.as('role' | 'target' | 'id')`. Only the Postgres
   round-trip could catch this, so that suite is required, not optional.
3. **The CLI process loaded app patterns before the library.** `pattern-globs.ts` imported only the registry. The
   library-name rule (and CAP-2's roles pre-flight, now that `Actor` is a library pattern) needs the library
   registered first. `loadAppPatternsForCli` imports the library barrel. The capability smoke proves it end to end:
   an app `Actor` must be refused with the new message.
4. **The scaffold's `@shared/base-classes/base-repository` is a stub.** It resolves scaffold-first to a hand-written
   stub with a drifted contract (its header, #603) that has no `col` / `scopeAnd`. The new suite imports the runtime
   classes by path. The existing suites are unaffected.
5. **Four test files re-seeded the library registry by hand**, listing six patterns each. That would have silently
   dropped `Actor` / `Communication` for every later test file in the Bun process. `LIBRARY_PATTERN_DEFINITIONS`
   (library barrel, exported from the package) is now the one list, and the barrel registers from it.
6. **The roles-test stubs are gone.** `validate-roles.test.ts` registered fake `Actor` / `Communication`; it now uses
   the library.
7. **#624 needed nothing.** The package leg's named expectation matched unchanged. The new repository import of the
   junction's *entity* module resolves in package mode, because the entity file has no `@shared/*` import.
8. **Typed role names became reachable.** M2's TS4105 was a consequence of the config being `protected`; once Found
   #1 made it public, `role: RoleOf<this>` works on the repository and through the forwarder. It is pinned by
   `test/smoke/fixtures/capability/consumer/checks/roles.check.ts`, compiled by both `tsc` legs: its
   `@ts-expect-error` probes fail the smoke (TS2578) if the parameter ever widens back to `string`.
9. **(Review) A group Actor's member entity was re-pluralized at emit time.** The first version used
   `pluralize(members.target)` for the table identifier and the folder, so a member entity declaring an irregular
   `plural:` got an unresolvable import. (The clean-lite-ps `belongs_to` path has the same pattern —
   `processBelongsTo`'s `relatedPlural = pluralize(target)`, and `processHasMany` — which predates this PR; filed as #630.) The
   zod-backed `loadEntityRegistry` (ADR-038) cannot be used from the hygen prompt: its import graph does not ship in
   the package's `files`. So the prompt reads the target's `entity:` block with `yaml` (`createEntityLookup`), and
   `entityModuleNaming` — also used for the entity's own `entityNamePlural` / module folder — turns it into the
   plural and path. A missing member YAML is a generation error. Unit-tested with `plural: personnel`, a
   `context:`-nested member, a missing member, a self-referential group (no duplicate import, TS2300) and the lookup
   itself.
10. **(Review) The identifier marker could collide.** `{ $identifier: '…' }` in an app capability's verbatim
    `config:` would have been rendered as code. The marker is now a module-private Symbol key; a test pins that the
    old shape renders as data.

## Acceptance — all met

Output from the runs made **after the last code edit** (charter I9); the table below is the only edit made after
them.

| Gate | Result |
|---|---|
| `bun run typecheck && bun run build && bun run test` | **exit 0** (baseline byte-identical) |
| `just test-all` | **exit 0** — unit **3303 pass / 0 fail** · baseline · smoke · smoke-subsystems · smoke-relationship · smoke-junction (×2) · **smoke-capability (vendored + package)**, with the library capabilities, the type-level role checks, 4 negative gates plus the library-name refusal per leg, public-emission assertions anchored, and the #624 expectation unchanged · junction snapshots 10/10 · integration-emit 56/56 · smoke-integration |
| `just test-integration` | **exit 0** — **74 pass** · 2 skip (pre-existing `test.skip` in `bridge-e2e.test.ts`) · 0 fail; the 10 new CAP-3 cases are included |
| `just test-post-publish` | **exit 0** — the tarball ships `with-actor.ts` / `with-communication.ts` and the consumer workflow compiles from it |
| `just test-smoke-junction-clean` | exit 1 — **known-red, #602**, still exactly **118**; untouched |

- **No filter, no `.skip`, no new expectation.** The #624 expectation is untouched and still matches, present and
  sole.
- **New `any`s:** one, `CapabilityCtor`'s rest parameter in `capability-mixin.ts` — the TS2545-mandated mixin idiom,
  identical to `RepositoryCtor`'s, with the same `eslint-disable` line. The scaffold suite keeps the scaffold's
  `let repo: any` precedent for the three repositories declared inside `beforeAll`; everything else in it is typed.
  **No `as unknown as`.**

## What downstream must know

**Using the capabilities.** `patterns: [<spine>, Communication]` + `roles:`; `patterns: [Actor]` +
`config: { Actor: { kind: individual } }` or `{ kind: group, members: <has_many name> }` — the config is required.
The names are the CAP-2 constants; an app pattern can no longer reuse them (or any library name).

**What the repository and service get.**
- `Communication`: `findByRole(role: RoleOf<this>, actorId)` → entity rows; `participants(id)` →
  `{ role, target, id }[]` (ids only). Both are forwarded on the service. `role` is typed to the declared role
  names (Found #8); at runtime an unknown role still throws, naming the declared roles.
- `Actor`: `memberPredicate(actorId): SQL` over the actor's own table. It is **not** forwarded. Use it inside that
  repository's own reads (`list({ where })`).
- All of them read through `baseQuery()` / `scopeAnd()`. The member hop in `memberPredicate` tests the FK only (see
  Risks).

**Emitted shape.** `communicationConfig` / `actorConfig` are `override readonly … as const` on the repository, with
**live table handles** imported from the junction / member entity module. `resolveLibraryCapabilityConfig` in the
clean-lite-ps prompt is where both are built; `identifierRef()` marks a bare identifier for
`renderPatternConfigLiteral` with a private Symbol key, so no key in an app capability's `config:` is reserved. A
cross-entity fact (a member entity's `plural:` / `context:`) is read from that entity's YAML through the
`entityLookup` local and `entityModuleNaming`; reuse those rather than calling `pluralize` on another entity's name. **Every** capability config is now public `override readonly` (Found #1).

**Writing a runtime mixin.** Annotate `TBase & CapabilityCtor<Surface>` with an exported `Surface` interface. The
CAP-1 `as TBase & typeof Mixin` idiom is fine for consumer mixins only (Found #1). Alias every raw `sql` field
that crosses a set operation (Found #2).

**For REL-1 / REL-2 (#625, epic #580).** `participants` is deliberately ids-only; hydration is the include tree's.
A many-role's edge (`via` junction, `self`/`target` columns) is in `communicationConfig`, but the manifest must
still derive it from `roles:` (I1), not from this emitted config. Per-hop scope for `memberPredicate`'s member hop
belongs there too.

**Registry.** `LIBRARY_PATTERN_DEFINITIONS` is the library list; a test that resets the registry re-seeds from it.
The CLI registers the library before app patterns (`pattern-globs.ts`).

## Open questions

None.
