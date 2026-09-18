# CAP-2 — the `roles:` block: named, typed edges to actor entities

**Status:** Draft
**Date:** 2026-09-17
**Issue:** #594 · **Epic:** #582 · **Project:** #578
**Depends on:** CAP-1 (#593) · **Blocks:** CAP-3 (#595)
**Governed by:** `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` (charter) · PLAN §6.3 ·
ADR-041 (capability composition) · `docs/specs/CAP-1.md` §"What downstream must know" · `docs/specs/REL-1.md` §5
(the `roles:` seam in the relations manifest)

## Why

A communication-style entity (meeting, email, message, transcript) is an interaction with **actors in roles** —
host, attendees, about. Today that can only be said as untyped `relationships:` entries whose *names* carry the
meaning by convention and whose actor-ness is nowhere declared:

```yaml
relationships:
  host_contact:   { type: belongs_to, target: contact, foreign_key: host_contact_id }
  about_account:  { type: belongs_to, target: account, foreign_key: about_account_id }
```

Nothing records that `contact` is a thing that can *occupy* a role, nothing stops a role pointing at an entity that
cannot, nothing gives the semantic model a role name to key a measure on, and the many-cardinality case (attendees)
has no declared home at all — it is just a junction somebody remembered to create.

`roles:` makes the edge a first-class declaration. CAP-3 then reads it: `Communication`'s mixin turns
`roles:` into `findByRole` / `participants`, and `Actor` marks the entities a role may point at.

## Charter invariants this PR touches

- **I1 declare once.** A `cardinality: one` role **derives** a `belongs_to` and then goes down the *existing*
  relationship path — `processBelongsTo` emits its FK column, its `.references(…, { onDelete })` and its index. No
  second FK emitter, no second nullability precedence, no second on-delete mapping. The derivation lives in one
  module that both the hygen prompt and the analyzer parser import (they do **not** share a loader — §3).
- **I2 generated means regenerated.** Roles add no new emitted file and no author seam; they add columns to the
  table the entity already regenerates.
- **I7 no backwards compat.** `roles:` is new surface. Nothing is dual-authored, and the equivalent hand-written
  `relationships:` entries keep working exactly as they do — they are simply not roles.
- **I9 honest gates.** The `one` path is proven by generated FK columns compiling in the capability smoke (both
  runtime modes); the `many` path and every rejection are unit-tested against the real schema and validator.
- **I11 scope discipline.** `clean-lite-ps` for emission. The schema, parser and validators are architecture-neutral
  because they are upstream of any pipeline; the `clean` pipeline consumes neither patterns nor roles (#602).

## The block

A **top-level sibling** of `fields:` / `relationships:` — not an annotation on `relationships:`, because a role is a
different kind of statement (who participates, in what capacity) and because annotating would mean every consumer of
`relationships:` has to learn to ignore a key it does not understand.

```yaml
roles:
  host:      { target: contact, cardinality: one,  column: host_contact_id }
  attendees: { target: contact, cardinality: many, via: meeting_contact }
  about:     { target: account, cardinality: one }
```

| Key | Required | Meaning |
|---|---|---|
| `target` | yes | entity name; must exist and must declare the **`Actor`** capability |
| `cardinality` | yes | `one` \| `many` |
| `column` | `one` only | FK column override; default `<role>_<target>_id` |
| `via` | `many` only, required | the junction between this entity and the target |
| `nullable` | `one` only | FK nullability; default `true` |
| `on_delete` | `one` only | `restrict` (default) \| `cascade` \| `set_null` \| `no_action` |

`.strict()` at every level: an unknown key, `via` on a `one` role, or `column` on a `many` role is an error at load,
not a silently ignored line.

## Design

### 1. `cardinality: one` derives a `belongs_to` — and nothing else changes

```yaml
roles:
  host: { target: contact, cardinality: one }
```
becomes, for every downstream consumer:
```yaml
relationships:
  host: { type: belongs_to, target: contact, foreign_key: host_contact_id, on_delete: restrict }
```

with `index: true` by default — a role edge exists to be traversed, and `findByRole` (CAP-3) is a lookup on that
column.

Precedence, all of it inherited from the existing path rather than restated:

| Property | Source |
|---|---|
| FK column name | `column:` → else `<role>_<target>_id` |
| `notNull` | the FK field's `required:` when the author also declares it in `fields:`, else the role's `nullable:`, else nullable |
| index | the FK field's `index:` when declared in `fields:`, else **`true`** (the role default) |
| `on_delete` | the role's `on_delete:`, default `restrict` (ADR-021) |

Declaring the FK column in `fields:` as well is the existing escape hatch for `required` / `unique` / `index` — it
already does not double-emit, because `processBelongsTo`'s FK names are filtered out of `processedFields`.

### 2. The relation key is the **role name**, not the target

`processBelongsTo` keys a non-self relation by the *target entity name* (`prompt-extension.js`), which is what the
generated service's composition method is called. Two `one` roles pointing at the same entity — `from` and `to` on an
email, `host` and `organizer` on a meeting — would both be called `contact`, which is a duplicate method (TS2393)
and, worse, a graph with two edges of one name.

So a role-derived relationship carries its role name and `processBelongsTo` uses it. Declared `relationships:` are
untouched: their key derivation is unchanged, so no existing output moves. This also matches REL-1's rule for the
manifest (`key = camelCase(role name)`), so the service method and the relation key agree.

### 3. One derivation, two importers

`prompt.js` parses the YAML **directly** (`yaml.parse`) — it does not go through `EntityDefinitionSchema` or
`loadEntityFromYaml`. So a schema-level `.transform()` would reach the analyzer and not the templates, and a
desugar written in the template would be a second implementation of the rules in §1.

The derivation is therefore a standalone module, `src/roles/derive.ts`, with no zod and no fs, imported by both:

```ts
export function deriveRoleRelationships(roles): Record<string, DerivedRoleRelationship>
export function roleForeignKey(role: string, target: string, column?: string): string
export const ACTOR_CAPABILITY = 'Actor';
export const COMMUNICATION_CAPABILITY = 'Communication';
```

It ships in the published `files` manifest next to `src/patterns/compose.ts` — and the CAP-1 manifest-coverage test
(`src/__tests__/templates/template-src-imports.test.ts`) proves it, because the templates import it.

`ParsedEntity` gains `roles: Map<string, ParsedRole>` **and** the derived relationships merged into its existing
`relationships` map, so the analyzer graph, `resolveReferences`, and every later consumer see a role as the edge it
is. `ParsedRole` keeps the declaration (target, cardinality, column, via) for CAP-3 and the semantic model.

### 4. `cardinality: many` emits nothing — it points at a junction

The `Junction` pattern already owns the m2m table, its FKs, and (after REL-1) its manifest edges. A `many` role
**names** that junction; it does not create a second way to make one. CAP-2's whole job on this path is validation:

- `via:` must name a junction between exactly this entity and the target. The junction name is not free-form — it is
  `between[0]_between[1]` (`deriveJunctionName`, the only naming rule, with no YAML override), so `via:` must be
  `<self>_<target>` or `<target>_<self>`.
- When junction definitions are available to the validator (the CLI passes `junctions/`), the named junction must
  actually **exist** and its `between` must be that pair. Without them the pairing rule above still applies.

`deriveJunctionName` moves from `src/cli/shared/barrel-generator.ts` (where it is private) to the junction schema
module, and both callers import it. One rule, two readers (I1).

### 5. Validation, and where each rule lives

| Rule | Where | Severity |
|---|---|---|
| block shape: unknown key, `via` on `one`, `column`/`nullable`/`on_delete` on `many`, missing `via` on `many` | `RolesSchema` (`.strict()` + `superRefine`) | load error |
| the derived `belongs_to` is itself well-formed (`on_delete: set_null` needs `nullable: true`, …) | the same `superRefine`, by running the **derived relationship through `RelationshipSchema`** | load error |
| a role key that collides with a declared `relationships:` key | `superRefine` | load error |
| `roles:` without the `Communication` capability, and `Communication` without `roles:` | `validatePatternComposition` (per-entity) | `error` issue |
| `target` resolves to a known entity | `validateRolesProject` (project-level) | `error` issue |
| `target` declares the `Actor` capability | `validateRolesProject` | `error` issue |
| `via` names a junction between the two entities | `validateRolesProject` | `error` issue |

Per-entity rules go where the per-entity validator already is; anything needing a second entity or a junction file
goes in the new project-level pass, wired into `analyzeDomain` next to `validatePatternProject`.

### 6. `Actor` and `Communication` are **not** shipped as library patterns here

They are CAP-3's, and CAP-1 already recorded why a placeholder is worse than nothing: a capability must contribute
columns, a mixin or forwarder methods, and a stub that declares a `mixinImport` for a module that does not exist
emits an import a consumer cannot resolve, while one that declares `forwarderMethods` emits service forwarders to
repository methods that do not exist yet (TS2339).

So CAP-2 validates by **name and kind**: the target's `patterns:` must include a registered `kind: 'capability'`
pattern named `Actor`. Until CAP-3 ships them, a project declares its own — exactly the app-capability path CAP-1's
smoke exercises. The error messages say so in words rather than pointing at a spec key:

> `Entity 'meeting' role 'host' targets 'contact', which does not declare the 'Actor' capability. Add 'Actor' to
> contact's patterns: (an ADR-041 kind:'capability' pattern).`

### 7. Fixture — and the spine it forces

PLAN §6.4 proposes `meeting` with `patterns: [Integrated, Activity, Communication]`. **That no longer generates**:
CAP-1 made two inheritable spine bases a hard error, and `Integrated` and `Activity` are both spines. The fixture
therefore declares:

| Entity | `patterns:` | Why |
|---|---|---|
| `meeting` | `[Activity, Communication]` | `Activity` is the spine — a meeting *is* a subject-scoped interaction, which is what that base class is for, and its config block is all-optional. `Integrated` is dropped rather than `Activity` because nothing in this fixture syncs from a provider. |
| `contact` | `[Group, Actor]` | an actor a role may point at |
| `account` | `[Group, Integrated, Individual, Audited, Actor]` | an actor too, and still CAP-1's composed-base case |

plus a `meeting_contact` junction for the `attendees` role. This extends the existing
`just test-smoke-capability` fixture set rather than adding a second harness — one tmp project, both runtime modes,
and the roles assertions sit next to the capability ones they depend on.

## Downstream contracts this PR does not implement

Both are on other tracks, unreachable from this branch without merging them, so CAP-2 **specifies** them and files
them rather than reaching across.

### (a) REL-1 — the relations manifest (epic #580)

REL-1 §5 already reserved the seam and chose **no `alias`** (its R2: `alias` is only read by v2's reverse-inference
branch, which never runs when `from`/`to` are both explicit). Two roles targeting the same table are therefore just
two explicitly-keyed edges. What `build-graph.ts` must add, at the `// CAP-2:` marker where edge sources are
concatenated:

| Role | Edge on the source entity |
|---|---|
| `cardinality: one` | `r.one.<target.plural>({ from: r.<self.plural>.<camel(fk)>, to: r.<target.plural>.id, optional: <same rule as belongs_to> })`, key `camelCase(role)` |
| `cardinality: many` | `r.many.<target.plural>({ from: r.<self.plural>.id.through(r.<via>.<camel(self)>Id), to: r.<target.plural>.id.through(r.<via>.<camel(target)>Id) })`, key `camelCase(role)` |

The `one` case needs **no new code** if REL-1 builds its edges from `ParsedEntity.relationships`, because this PR
merges role-derived relationships into that map with the role name as the key — the manifest gets the right edge
with the right key for free. The `many` case is the one that needs the marker: it is a junction edge keyed by the
role rather than by the target's plural, and the junction-derived edge for the same pair also exists, so the two
must not collide — REL-1's duplicate-key detector is what catches it, and the role key should win by being emitted
from the role rather than suppressing the junction edge.

### (b) SEM-2 — the semantic model (epic #581)

Each role is a `belongs_to` / `has_many` descriptor **keyed by the role name**, with `target` the actor entity:
`{ kind: 'belongs_to' | 'has_many', name: '<role>', target: '<actor plural>', via: '<junction plural>'? }`. The role
name is the dimension label a measure groups by (`by host`, `by attendee`), which is precisely the thing the old
target-keyed derivation could not express when two roles share a target.

## Out of scope

- `Actor` / `Communication` runtime mixins and their library pattern definitions — **CAP-3**.
- Emitting `patternConfig.roles` on the generated repository — **CAP-3**. CAP-2 leaves the data reachable: every
  role-derived entry in `clpBelongsTo` carries its `role` name.
- `to_shape` projections, the selector catalog, and any change to `Activity`'s subject semantics (PLAN §6.5).
- The frontend emitter: it builds its own view of relationships and is FE-REL's surface.
- The `clean` pipeline (#602).

## Risks

| Risk | Signal | Response |
|---|---|---|
| Role-keyed relations change an existing entity's emitted service method | baseline / junction snapshots move | only role-derived entries take the new key; declared relationships keep the old derivation. The snapshots are the check |
| A role FK collides with a declared field or another role's FK | duplicate column in the emitted table | the schema rejects a role key colliding with a relationship key; a *column* collision surfaces as a duplicate pgTable key — add an explicit check if the fixture shows it reachable |
| `via` validation is weaker when junction files are not passed | a typo'd `via` passes `entity validate` | the pairing rule still applies; the CLI passes `junctions/`, so the full check runs on the path consumers actually use |
| CAP-3 finds `ParsedRole` missing a field it needs | rework in CAP-3 | `ParsedRole` keeps the declaration verbatim (target, cardinality, column, via, nullable, on_delete) rather than only the derived form |

## What downstream must know

*(filled in at implementation; see the merged version)*

## Open questions

None.
