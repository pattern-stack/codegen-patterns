# RFC-0006 — Joined-table inheritance: `inherits:` in entity YAML

**Status:** Draft, revision 3 — Doug's answers of 2026-11-13 are recorded in §11, including OQ-11 (the part-kind
rule is a composite FK on the part's own discriminator; the user-facing `checks:` key leaves this build). S1
(schema and validation), S2 (the DDL) and S3 (relations, scope and reads) are built; nothing else is. §13.2 S1, S2 and
S3 say what each build settled.
**Issue:** #875
**Date:** 2026-11-12, revised 2026-11-13
**Owner:** Doug
**Related:** #783 (schema expressiveness epic), #780 (natural keys), #786 (`checks:`), #787 (composite FKs), #788
(`one_of:`), #812 (`entity_ref`); ADR-021 (on-delete), ADR-041 / ADR-041.1 (capabilities, `roles:`), ADR-042 (tenant scoping), ADR-044
(relation graph is the read contract); `docs/specs/READ-1.md` (the read API), `docs/specs/FE-REL.md` (frontend graph).
Reference implementation: `github.com/dugshub/geoabacus`, `app/models.py` @ `3fed3c01` (2024-10-02).

Every claim about the generator cites `path:line` at `main` @ `074cce00`. Sketches of emitted code are sketches: they
show the shape, and none has been compiled.

## Goal

Entity YAML cannot say "this entity IS a kind of that one". The entity schema is `.strict()`
(`src/schema/entity-definition.schema.ts:1368`), relationships are `belongs_to | has_many | has_one` (`:428`), and
every entity table gets its own generated key: `id: uuid('id').primaryKey().defaultRandom()` is a literal in the
template (`templates/entity/new/backend/entity.ejs.t:32`).

The workaround is a child with its own `id` and a unique `belongs_to` to the base. That is composition: two ids per
row, nothing ties the child to the base's `kind`, and no generated read, write or DTO knows the two rows are one thing.

This RFC adds one line to a child's YAML:

```yaml
inherits: communication
```

From it the generator derives the shared-key DDL, a database-enforced kind, both relation edges, flat DTOs, pair
writes and a pair upsert in one transaction, and a typed "all kinds" read. The same build adds `match:` on a
`belongs_to` (#787's composite FK), because two of the first consumer's rules need it (§2.4). Storage is exactly SQLAlchemy 2's joined-table inheritance.
The mapping is not: there is no polymorphic object mapper, and §9 argues why.

## Decisions at a glance

| Topic | Decision |
|---|---|
| Keys | Child: `inherits: <base>` or `inherits: { base, as }`. Base: `discriminator: <enum field>`. |
| Child key | `id` is the primary key and a foreign key to the base row. No `defaultRandom()`. |
| Kind integrity | Composite FK `(id, kind) → base(id, kind)`, with `kind` on the child fixed by `DEFAULT` + `CHECK`. |
| Tenancy | Declared on the base only, and the base's tenant column must be NOT NULL. The child carries the column too, pinned by a second composite FK. |
| Lifecycle behaviors | `timestamps`, `soft_delete`, `user_tracking`, `external_id_tracking` live on the base only. |
| Delete | Always cascades from the base. No `on_delete` option. |
| Levels | One. A child cannot be a base. |
| Reads | The READ-1 surface is unchanged. The base row is a relation (`with: { communication: true }`). Flat rows are a projection of that read, not a second query path. |
| Writes | The child repository's `create` / `update` / `delete` write the pair in one transaction. |
| Upsert | `upsertByNaturalKey` on the child: the base on its declared natural key, then the child on `id`, one transaction. In v1. |
| Cross-family rules | `match:` on a `belongs_to` emits a composite FK to the parent's `(id, <column>)`. In v1. |
| Frontend | The graph gets both edges. v1 also emits a typed "child with its base" query and hook per `electric` child. |
| DTOs | Child DTOs are flat (base fields + child fields, no `kind` on input). |
| Kind change | Refused. Delete and create. |

## When to use it

Doug's rule (2026-11-10): use inheritance when X **is** a kind of one thing **and** you read across kinds. Use
composition when X merely **has** a part that is only read inside X.

| You have | Use | Why |
|---|---|---|
| Several entities that are kinds of one thing, listed together, pointed at as "any kind" | `inherits:` | One base table gives every referrer one real FK and gives cross-kind reads one table to scan. |
| A row that points at exactly one of several unrelated entities (a payment applies to an invoice or a credit note) | `one_of:` (#788) | The targets share no identity or lifecycle and nobody lists them together. Typed nullable FKs plus a CHECK. |
| A part that is only read through its owner (a meeting's transcript) | `belongs_to` / `has_many` | Composition. The part has its own id and its own lifecycle. |

A test for choosing between the first two: if two or more referrers would need the same `one_of:` group, or anything
lists across the group, promote the group to a base. `type: entity_ref` (#812) is the no-FK form, which the standing
rule "never a `(type, id)` pair without an FK" rules out. The first consumer's party entity is that form today
(an `interaction_type` string + an `interaction_id` "LOOSE FK"). Under this RFC it becomes
`communication_participant.communication_id → communications.id`.

## 1. YAML surface

### 1.1 The two keys

Both are top-level siblings of `relationships:` and `roles:`, not keys inside the `entity:` block. Like a `roles:`
entry (`entity-definition.schema.ts:1147-1154`), each is a statement about how this entity relates to another.

```yaml
# definitions/entities/communication.yaml — the base
entity:
  name: communication
  plural: communications
  patterns: [Activity]
tenant_scoped: true
discriminator: kind                    # names an enum field declared below
behaviors: [timestamps]
fields:
  tenant_id:   { type: uuid, required: true }      # adopted by tenant_scoped; NOT NULL (R10)
  kind:        { type: enum, choices: [meeting, email, message], required: true }
  occurred_at: { type: datetime, required: true }
  source:      { type: string, required: true, max_length: 32 }
  external_id: { type: string, required: true }
unique_indexes:
  - fields: [source, external_id]
    natural_key: true                  # the pair upsert's conflict target (§4.2)
```

```yaml
# definitions/entities/meeting.yaml — a child
entity:
  name: meeting
  plural: meetings
inherits: communication                # short form: the kind value is the entity name
fields:
  title:     { type: string, required: true }
  starts_at: { type: datetime, required: true }
  ends_at:   { type: datetime, nullable: true }
  link:      { type: string, nullable: true }
relationships:
  transcripts: { type: has_many, target: meeting_transcript, foreign_key: meeting_id }
```

```yaml
# long form, when the kind value is not the entity name
inherits:
  base: communication_part
  as: meeting
```

`inherits.base` is an entity name, resolved against the target's own YAML (`projectEntityLookup`, NAME-0). `as`
defaults to `entity.name` and must be one of the base's discriminator choices.

### 1.2 Rules

| # | Rule | Reason |
|---|---|---|
| R1 | `discriminator:` names a `type: enum`, `required: true` field on the same entity, with literal `choices:` or `choices_of: <entity>.<field>` (§2.4). | The column is the FK target and the union's tag. `choices_of:` lets a base's kinds be another family's kinds, which is how `communication_part` ties its kind to its communication's (§2.4, case 1). |
| R2 | Each choice has at most one child. A choice with no child is a **base-only kind** (`message` above). | Doug's draft lists three kinds and two child tables. |
| R3 | A child may not declare `discriminator:`. A base may not declare `inherits:`. | One level (§8). |
| R4 | A child's field, FK column or relation key may not reuse a name the base declares, and the reverse. | DTOs and flat rows merge the two. |
| R5 | `tenant_scoped`, `timestamps`, `soft_delete`, `user_tracking`, `external_id_tracking` are declared on the base. Declaring one on a child is an error naming the base. | One owner for lifecycle and scope (§2.3). |
| R6 | A pattern or capability is declared on the table that owns its columns. | See 1.3. |
| R7 | A child's `queries:` may name only its own columns. | A finder by a base column is a base read (§3). |
| R8 | Base and children share one `entity.sync` mode. | An `electric` root reaching a non-`electric` target is already a generation error (FE-REL). |
| R9 | `eav: true` and `pattern: Junction` are refused anywhere in a family in v1. | Their compound writes would need merging with the pair write. |
| R10 | A `tenant_scoped` base declares its tenant column itself, NOT NULL: a `type: uuid, required: true` field, or a `belongs_to` whose FK is not `nullable`. | The column `tenant_scoped` emits on its own is nullable (`entity.ejs.t:51-57`), and a composite FK is not checked for a NULL. An adopted column keeps its own declaration (`src/schema/tenancy.ts:126-166`). |
| R11 | At most one `unique_indexes` entry per entity carries `natural_key: true`, and every column in it is NOT NULL. A child declares none. | It is the `ON CONFLICT` target of the upsert, and a NULL in it never conflicts. |

R1 to R3, R5, R9, R10 and R11 are schema or cross-entity checks. The single-file ones (R5, R9, R11, R1's and R3's
own-file halves) are a Zod refinement in `src/schema/inheritance.ts`. The cross-entity ones are in
`src/parser/validate-inheritance.ts`, called from the `entity new` pre-flight and from `analyzeDomain`, because they
read two files (§13.2, "S1 as built").

### 1.3 Patterns, capabilities and `roles:`

A pattern base class reads columns on its own table (`ActivityEntityRepository` resolves `occurred_at` through
`this.col(...)`, `runtime/base-classes/activity-entity-repository.ts:82`). So:

- **`Activity`** goes on the base when `occurred_at` is a base field. `findByDateRange` on the base then returns all
  kinds, which is the cross-kind read the feature exists for.
- **`Communication` + `roles:`** go on the base. Role FK columns and junctions hang off `communications`. A role
  declared on the base is read through the base (`communicationService.findByRole`), not re-exposed on each child.
- **`Actor`** may be declared on a base or a child. A role may target a child: that is a real FK to the child table.
- A child may declare a pattern only over its own columns. R6 compares the columns the pattern says it reads
  (`PatternDefinition.columnsRead`, §13.2), not config strings. A pattern whose repository reads a column the base
  owns is an error naming the base.

Doug's draft models participants as an entity (`communication_participant`), not `roles:` FK columns. Both work. The
entity form is the one drawn in §7.

### 1.4 Naming

Doug's rule is that a child takes its parent's name as a light prefix, one level only. The generator enforces
nothing here. It derives two relation keys from the names: the child gets `<base name>` (`meeting.communication`) and
the base gets one key per child (`communication.meeting`, `communicationPart.transcriptCommunicationPart`).

## 2. DDL

### 2.1 Emitted tables

```ts
// modules/communications/communication.enums.ts — a LEAF module: it imports only drizzle-orm/pg-core (see below)
export const communicationKindEnum = pgEnum('communication_kind', ['meeting', 'email', 'message']);
```

```ts
// modules/communications/communication.entity.ts
import { communicationKindEnum } from './communication.enums';
export { communicationKindEnum };   // the schema barrel and drizzle-kit read this file's exports

export const communications = pgTable(
  'communications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: communicationKindEnum('kind').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    source: varchar('source', { length: 32 }).notNull(),
    externalId: varchar('external_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (tCols) => [
    index('communications_tenant_id_idx').on(tCols.tenantId),
    // natural_key: tenant-prefixed, as every unique on a tenant_scoped entity is
    unique('communications_tenant_id_source_external_id_uniq').on(tCols.tenantId, tCols.source, tCols.externalId).nullsNotDistinct(),
    // inherits: the targets of each child's two composite FKs
    unique('communications_id_kind_uniq').on(tCols.id, tCols.kind),
    unique('communications_id_tenant_id_uniq').on(tCols.id, tCols.tenantId),
  ],
);
```

```ts
// modules/meetings/meeting.entity.ts
import { communications } from '../communications/communication.entity';
import { communicationKindEnum } from '../communications/communication.enums';   // the leaf, never the entity file

export const meetings = pgTable(
  'meetings',
  {
    id: uuid('id').primaryKey(),                                   // the base row supplies it
    kind: communicationKindEnum('kind').$type<'meeting'>().notNull().default('meeting'),
    tenantId: uuid('tenant_id').notNull(),
    title: varchar('title').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    link: varchar('link'),
  },
  (tCols) => [
    index('meetings_tenant_id_idx').on(tCols.tenantId),
    foreignKey({
      name: 'meetings_communication_kind_fk',
      columns: [tCols.id, tCols.kind],
      foreignColumns: [communications.id, communications.kind],
    }).onDelete('cascade'),
    foreignKey({
      name: 'meetings_communication_tenant_fk',
      columns: [tCols.id, tCols.tenantId],
      foreignColumns: [communications.id, communications.tenantId],
    }).onDelete('cascade'),
    check('meetings_kind_check', sql`${tCols.kind} = 'meeting'`),
  ],
);
```

**Enums live in a leaf module, for every entity.** An entity that declares a `pgEnum` emits it into
`<entity>.enums.ts`, which imports nothing but `drizzle-orm/pg-core`; the entity file imports and re-exports it.
A child's `kind`, a `choices_of:` column and a `match:` column call the owner's `pgEnum` at module top level, and the
entity files of a base, its children and its referrers import each other (a base that has a `belongs_to` to one of
its referrers is a cycle). Importing the enum from the owner's *entity* file would read a `const` that has not run
yet — `ReferenceError: Cannot access 'communicationKindEnum' before initialization` at boot, which `tsc` cannot see.
The `tCols` parameter is likewise one name for every table: a function that reads a table export declares no
binding a plural could equal (#813), and a callback that rewrote `t.` after the fact would also rewrite a string
literal in a raw-SQL predicate.

`emails` is the same with `default('email')`, its own CHECK, and `thread_id uuid references email_threads(id)`.
Enum and constraint names follow the existing rules (`entity-locals.js:597`, `:2168-2223`). Postgres truncates an identifier at 63 bytes; the build checks only the names the table's extra-config callback declares, and an explicit `foreignKey({ name })` on every FK is #921's.

**`kind` and the tenant column on the child are copies, on purpose.** Each is a value the base row owns, repeated
on the child so that a constraint, a scope predicate or a shape filter can read it without a join. Neither can
drift: both are immutable, and each is one half of a composite FK to the base, so the database rejects a child whose
copy disagrees. Nothing else is copied. `deleted_at`, `updated_at` and every other base field stay on the base only
(§2.3). The same holds for a `match:` column (§2.4).

What is new to the entity templates: the conditional `id` line, and two builders in the extra-config list.
`foreignKey` exists in drizzle-orm 1.0.0-rc.4 (`node_modules/drizzle-orm/pg-core/foreign-keys.d.ts:41`, `.onDelete`
at `:24`) but no entity template calls it. `check` is used only by subsystem schemas
(`runtime/subsystems/events/domain-events.schema.ts:123-126`).

### 2.2 Kind integrity: the composite FK

The requirement: a `meetings` row must never sit under a `communications` row whose `kind` is `email`.

| Option | DB-enforced | Extra storage | Visible to drizzle-kit diff | Cost |
|---|---|---|---|---|
| **A. Composite FK + fixed `kind` on the child** (chosen) | yes | 4 bytes per child row; one unique index on the base | yes, all of it is `pgTable` config | One more index maintained per base insert. The child's FK check uses it. |
| B. Trigger on the child | yes | none | no: Drizzle has no trigger builder, so it is raw SQL outside the schema | Per-row plpgsql. A second migration channel, the thing #783 complains about. |
| C. Service only | no | none | n/a | Breaks "DB constraints over service-seam enforcement". |

Three details of A:

- **`DEFAULT` + `CHECK`, not a generated column.** Postgres does not publish generated columns over logical
  replication before 18, and only when `publish_generated_columns = stored` from 18
  ([Postgres 18 docs](https://www.postgresql.org/docs/18/logical-replication-gencols.html)). Electric reads the
  replication stream, so a plain column is the safe choice for "every table is usable as a shape". I did not find
  Electric's own statement on generated columns, so treat that half as unverified.
- **The CHECK goes through an internal check builder**, one more entry in the `tableConstraints` list
  (`entity-locals.js:2168`). It is not a YAML key: the user-facing `checks:` list stays whole in #786 (OQ-11).
- **The base's `unique(id, kind)` is reusable.** It is what a referrer needs to say "a communication of this kind"
  with a composite FK. That is `match:` (§2.4).

The FK's default `ON UPDATE NO ACTION` means the database also refuses to change `communications.kind` while a
child row exists.

**What it does not enforce: completeness.** A `communications` row with `kind = 'meeting'` and no `meetings` row is
legal to Postgres, because the base is inserted first. Closing that needs a deferred constraint trigger (option B's
cost). v1 guards it in the generated write path (§4) and gives a `findOrphans()` check (§6). Decided: OQ-8.

### 2.3 Tenancy and lifecycle

**The child carries the tenant column.** Three reasons, each from code:

1. Scope is a per-table column predicate. `scopeFilter(table, cfg, owner)` reads the tenant column on the table it is
   given (`runtime/base-classes/scope-filters.ts:194-214`), at the root and at every hop (charter I3).
2. An Electric shape filters on its own table. The frontend emitter writes only the shape's `url` and `table`
   (`src/emitters/frontend/emit-collections.ts:61-107`); tenant filtering is the host's shape proxy, which needs a
   column to filter on.
3. The tenant is immutable (`guardTenantOnUpdate`, `base-repository.ts:907-926`), so a copy cannot drift once it is
   pinned.

It is pinned by the second FK, `(id, tenant_id) → communications(id, tenant_id)`. `tenant_scoped` is declared on the
base only. The child's column, index, `tenantScoped: true` and `scopeEnforcement: 'strict'` are derived from it, with
the base's column name (`resolveTenancy`, `src/schema/tenancy.ts:126`).

R10 makes the base's tenant column NOT NULL, and the child's derived column is emitted `.notNull()`, so this FK is
checked for every row. The tenant and kind FKs stay two constraints, not one three-column FK, because each of the
base's two unique indexes is also a target other referrers use: `(id, kind)` for `match:` (§2.4) and `(id, tenant)`
for #787's same-tenant FK.

**`soft_delete` and `user_tracking` stay on the base, with no copy.** `deleted_at` is mutable, so a copy would
drift. Instead a child row is in scope only if its base row is: the child's scope gains
`EXISTS (SELECT 1 FROM communications b WHERE b.id = <child>.id AND <base scope on b>)`. This is one optional field
on `ScopeConfig` (`scope-filters.ts:65`) and its emitted twin (`src/emitters/relations/types.ts:31`), so the root
filter (`scopeAndOn`, `base-repository.ts:962-971`) and every hop (`hopScope`, `scope-filters.ts:226`) get it from
one place. It is emitted only when the base declares `soft_delete` or `user_tracking`. A family that is only
tenant-scoped pays nothing, because the child's own tenant column already carries the scope.

**`timestamps` stay on the base.** Any write to the child bumps the base's `updated_at` (§4), so the family has one
"last changed".

### 2.4 `match:` — composite FKs for cross-family rules (#787)

Two rules of the first consumer's model that `inherits:` alone does not give:

1. a `transcript` communication part sits only under a communication of kind `meeting`;
2. a participant's role is one defined for its communication's kind.

Both say "the row I point at must agree with me on a column". That is #787's composite FK. This build adds #787's
explicit form, `match:` on a `belongs_to`, on the same `foreignKey` emitter the inheritance FKs use.

```yaml
relationships:
  communication:
    type: belongs_to
    target: communication
    foreign_key: communication_id
    on_delete: cascade
    match: { communication_kind: kind }      # <local column>: <target column>
```

`match: [revision_id]`, #787's spelling, is shorthand for `{ revision_id: revision_id }`.

What it emits:

- **A derived local column.** `communication_kind` takes the target column's SQL type (here the base's `pgEnum`) and
  is NOT NULL unless the FK is `nullable`. The author declares no field for it.
- **One composite FK** in place of the single-column `.references()` (`entity.ejs.t:41`):
  `(communication_id, communication_kind) → communications(id, kind)`, with the relationship's `on_delete`.
- **A unique index on the target**, `unique(id, <target columns>)`, deduplicated by column set. A base already has
  `(id, kind)` from `discriminator:`. The target's entity file is rendered by its own template from the referrers'
  YAML, the rule junction fan-out already follows (`templates/_shared/junction-fan-out.mjs`), so adding a `match:`
  re-renders the target.
- **The value is never client input.** The column is absent from the create and update DTOs. The generated insert fills it with a scalar subquery in the same statement
  (`(SELECT kind FROM communications WHERE id = $1)`), and an update that changes the FK re-derives it. A missing
  parent then fails as NOT NULL, which the repository maps to the same error as an FK violation.

| # | Rule |
|---|---|
| M1 | `match:` is valid on `belongs_to` only. Each target column exists on the target and is NOT NULL. |
| M2 | The local column name may not be a declared field, FK column or behavior column, with one exception: the entity's own `discriminator:` field, when its enum is the target column's (`choices_of:`). That column is not derived and not filled by a subquery. The write path supplies it (a child's `as:`, or the base-only kind the caller passes) and the composite FK checks it. |
| M3 | Two relationships may match the same local column when the two target columns have the same SQL type. The first declared fills it and the database checks the other. The one derived column is NOT NULL as soon as **any** relationship matching it is NOT NULL, whichever is declared first: a NULL in a composite FK's columns skips the check (MATCH SIMPLE), so a nullable column shared with a NOT NULL FK would silently disable that FK's rule. |
| M4 | A matched column is immutable while the FK is unchanged. |
| M5 | An enum target column needs one Postgres type on both sides. See `choices_of:` below. |

**When every relationship matching a column is nullable**, the derived column is nullable too, and a set FK with a
NULL derived column would skip its composite check. So the entity carries an internal CHECK per such relationship,
`<table>_<relationship>_match_check`: `<fk> IS NULL OR <derived> IS NOT NULL`, through the same internal check builder
as the child's kind CHECK. The requirement is only that a **set** FK is always checked, so a set FK always has its
derived column. The reverse is allowed: a derived column with no FK is harmless, and for a column shared by two
nullable relationships one FK may be set while the other is NULL (the column is then set, and the set FK is checked
against it). A relationship matching several nullable columns gets one conjunct per column.

**Case 1: a transcript part only under a meeting.** The FK to the communication is on the part's base, so that is
where the rule goes. The part's kinds *are* the communication's kinds, and the part's own discriminator is the
matched column (M2's exception):

```yaml
# communication_part.yaml
discriminator: kind
fields:
  kind: { type: enum, choices_of: communication.kind, required: true }   # meeting | email | message
relationships:
  communication:
    type: belongs_to
    target: communication
    foreign_key: communication_id
    on_delete: cascade
    match: { kind: kind }      # (communication_id, kind) → communications(id, kind)
```

One composite FK, no derived column and no CHECK. A part of kind `meeting` (the transcript part, `inherits: { base:
communication_part, as: meeting }`) can only sit under a communication of kind `meeting`; a transcript part under an
email fails with `23503`. The database checks it with the same machinery as the kind FK, and no SQL string repeats
the enum's values.

It holds while each communication kind has at most one part kind (R2 on the part base). If a meeting ever has two
part kinds, the rule becomes case 2's shape: a part-kind lookup `(part_kind, communication_kind)` that the part
matches on both columns. Still FK-only, no raw SQL (OQ-11, decided 2026-11-13).

**Case 2: a participant's role belongs to the communication's kind.**

```yaml
# communication_participant_role.yaml — the lookup
entity: { name: communication_participant_role, plural: communication_participant_roles }
fields:
  kind: { type: enum, choices_of: communication.kind, required: true }
  role: { type: string, required: true, max_length: 32 }
unique_indexes:
  - fields: [kind, role]
```

```yaml
# communication_participant.yaml
entity: { name: communication_participant, plural: communication_participants }
tenant_scoped: true
fields:
  tenant_id: { type: uuid, required: true }
relationships:
  communication:
    { type: belongs_to, target: communication, foreign_key: communication_id, on_delete: cascade,
      match: { communication_kind: kind } }
  role:
    { type: belongs_to, target: communication_participant_role, foreign_key: role_id,
      match: { communication_kind: kind } }
  person: { type: belongs_to, target: person, foreign_key: person_id, nullable: true }
```

```ts
// communication-participant.entity.ts (fragment)
communicationKind: communicationKindEnum('communication_kind').notNull(),
// …
foreignKey({
  name: 'communication_participants_communication_match_fk',
  columns: [tCols.communicationId, tCols.communicationKind],
  foreignColumns: [communications.id, communications.kind],
}).onDelete('cascade'),
foreignKey({
  name: 'communication_participants_role_match_fk',
  columns: [tCols.roleId, tCols.communicationKind],
  foreignColumns: [communication_participant_roles.id, communication_participant_roles.kind],
}).onDelete('restrict'),
```

One column, `communication_kind`, is held by both FKs (M3). The first proves it is the communication's kind. The
second proves the role row is a role of that kind.

`choices_of: <entity>.<field>` is one new field option: "this enum is the same Postgres type as that field". It is
needed because enum types are namespaced per entity (`entity-locals.js:590-597`), and Postgres will not build an FK
between two different enum types. It imports the owner's `pgEnum` and declares no type of its own. `choices_from:`
is unrelated: it loads choices from a file (`entity-definition.schema.ts:229-231`).

**What stays in #787:** the implicit same-tenant FK on every `belongs_to` between tenant-scoped entities, the
`cross_tenant:` opt-out, and the use-case 422. They change the DDL of every tenant-scoped relationship, which is a
separate decision (OQ-12).

## 3. Relations and reads

### 3.1 What `defineRelations` gets

Two edges per child, added in `buildRelationGraph` (`src/emitters/relations/build-graph.ts:200`), next to the
`belongs_to` and `has_one` branches (`:259-293`):

```ts
// relations.ts (fragment)
communications: {
  meeting: r.one.meetings({ from: r.communications.id, to: r.meetings.id, optional: true }),
  email:   r.one.emails({ from: r.communications.id, to: r.emails.id, optional: true }),
  participants: r.many.communicationParticipants({ /* … */ }),
},
meetings: {
  communication: r.one.communications({ from: r.meetings.id, to: r.communications.id, optional: false }),
  transcripts: r.many.meetingTranscripts({ /* … */ }),
},
```

Each carries the usual `where: { RAW: (t) => hopScope(…) }` when the target declares a scope (`renderEdge`,
`emit-manifest.ts:61`). The child-to-base edge is `optional: false`: the child's own scope already requires the base
row to be in scope (§2.3), so the hop cannot drop it. That is an exception to `hopCanDropTarget`
(`build-graph.ts:141-142`). The edge carries an `inherits` marker so the builder, and the frontend emitter (§3.4),
can tell.

The frontend graph calls the same `buildRelationGraph` (FE-REL), so both edges reach `graph/descriptor.ts`. §3.4
covers what the client gets.

### 3.2 Reading a child

The READ-1 surface does not change. Every generated read still takes `columns` and `with` and runs on RQBv2
(`repository.ejs.t:286-339`). The base row is one more relation:

```ts
// table-shaped: the meetings columns only
const m = await meetingRepo.findById(id);

// with its base, nested. One statement, a lateral join on the primary key.
const m = await meetingRepo.findById(id, { with: { communication: true, transcripts: true } });
m.communication.occurredAt;

// flat: a projection of that same read
const flat = flattenBase(m, 'communication');   // { id, kind: 'meeting', title, occurredAt, transcripts, … }
```

`flattenBase` is a pure function plus a type. It hoists the base relation's columns to the root. There is no second
query path, so `columns`, `with`, the scope and the one-statement rule (charter I4) all hold for flat reads.
`findWithBase(id, opts?)` is the generated shorthand for the last two lines (§6).

Filtering or sorting a child list by a **child** column is the child's `list()` as today. By a **base** column
(`occurred_at`, `created_at`) it is a base-rooted read, because the generated `list` orders by the root table's
columns (`orderByOn(t, sort)`, `repository.ejs.t:334`) and the base table has the index. That is `listKind` below.

### 3.3 Reading across kinds

```ts
const rows = await communicationRepo.findAllKinds({
  where: (t) => gte(t.occurredAt, since),
  sort: [{ column: 'occurredAt', direction: 'desc' }],
  limit: 50,
});

for (const c of rows) {
  switch (c.kind) {
    case 'meeting': c.meeting.title; break;     // Meeting, not Meeting | null
    case 'email':   c.email.subject; break;
    case 'message': break;                      // base-only kind
  }
}
```

It is `list({ …, with: { meeting: true, email: true } })` followed by a narrowing step. One statement: the base scan
plus one primary-key lateral join per child kind. The result type is generated:

```ts
export type CommunicationOfKind =
  | (Communication & { kind: 'meeting'; meeting: Meeting })
  | (Communication & { kind: 'email'; email: Email })
  | (Communication & { kind: 'message' });
```

The narrowing step is the **kind guard**. A row whose `kind` has a child table but whose child came back `null`
throws `OrphanBaseError` naming the id and kind. It does not return a half-typed row.

`findAllKinds({ kinds: ['meeting'] })` adds `kind IN (…)` and joins only those children.
`listKind('meeting', query)` is the one-kind case, returned flat (`MeetingFlat[]`). It is what a child's HTTP list
uses, since that list's default sort is `created_at desc, id desc` (`use-cases/list.ejs.t:111`) and `created_at` is a
base column.

A `with` under a child (`with: { meeting: { with: { transcripts: true } } }`) works on the plain `list()` today,
because the edges are ordinary relations.

### 3.4 On the frontend (Electric)

The frontend joins collections the way an ORM loads relations, so "a child with its base" is the normal read there,
not an edge case. It is also the only correct one. A child's shape holds every child row the shape proxy lets
through, including a row whose base is soft-deleted or outside the base's shape. A child row on its own says nothing
about whether the thing still exists. Clients always read a child through its base.

**What FE-REL's generated graph gives, with no new work.** The frontend graph calls the same `buildRelationGraph`,
so both edges are in `graph/descriptor.ts`, and each `electric` entity's accessor carries them:

- `useMeetingGraph(id, { communication: true })` is one live query: the root row with every to-one hop joined in
  (`src/emitters/frontend/emit-graph.ts:34-35`, `:522-531`). The hop is typed without `| undefined` when the edge is
  `optional: false` (`:336`).
- `useCommunicationGraph(id, { meeting: true, email: true })` joins each child, typed `| undefined`.
- Base and child must both be `electric` (R8), or generation fails naming both.

**Two gaps, both closed in v1.**

1. *A to-one hop is left-joined* (`emit-graph.ts:486`). A meeting whose base row is not in the client would come
   back with no `communication` while its type says there is one. Fix: `RelationEdge` gains a marker,
   `inherits: 'base' | 'child'` (`src/emitters/relations/types.ts:65`). The backend reads it for the
   `optional: false` exception (§3.1). The frontend emitter reads it to **inner-join** the child-to-base hop, so the
   root row does not exist on the client until its base does. The descriptor stays edge-for-edge equal to REL-1's.
2. *Graph accessors are by id.* The common screen is a list: meetings ordered by `occurred_at`.

So v1 emits a small typed helper per `electric` child, in its `graph/<child>.ts`:

```ts
/** The backend's MeetingFlat, on the client. */
export type MeetingWithBase = Omit<Communication, 'kind'> & Meeting;

/** meetings ⋈ communications on id. A query fragment: add where / orderBy / limit to it. */
export function meetingsWithBase(q: InitialQueryBuilder) {
  return q
    .from({ row: meetingCollection })
    .innerJoin({ base: communicationCollection }, ({ row, base }) => eq(row.id, base.id));
}

export function useMeetingsWithBase(): { data: MeetingWithBase[]; isLoading: boolean; isError: boolean };
export function useMeetingWithBase(id: string | null | undefined): { data: MeetingWithBase | undefined; isLoading: boolean; isError: boolean };
```

The inner join is the point. A child whose base has left the base shape disappears from every list with no client
code. A `sync: api` child needs no helper: its REST routes already return the flat shape (§5).

Not in v1: a cross-kind list helper on the base (`communications` left-joined to each child). The by-id accessor
covers a detail view, and a list across kinds usually renders base columns only.

Gate: `test/smoke/fixtures-frontend/usage/` gets a real assignment from `useMeetingsWithBase()` to
`MeetingWithBase[]`, and a `@ts-expect-error` on reading `communication` as possibly undefined, compiled by
`just test-smoke-frontend`.

## 4. Writes

### 4.1 Create, update, delete

The child repository is the one owner of the pair write. Its generated `create`, `update` and `delete` override the
base class's (`base-repository.ts:432`, `:450`, `:468`), so the service, the use cases and hand-written callers all
get pair semantics through the methods they already call.

| Operation | What runs | Statements |
|---|---|---|
| `create(input, tx?)` | Split `input` by owner. `baseRepo.create({ …baseFields, kind: 'meeting' }, tx)`, then insert the child with `id = base.id`. Opens a transaction when no `tx` is passed. | 2 inserts, 1 transaction |
| `update(id, patch, tx?)` | A `kind` key throws `KindImmutableError`. Split the patch. `baseRepo.update` always runs (it bumps `updated_at`); the child update runs when the patch has child keys. | 1 or 2 updates, 1 transaction |
| `delete(id, tx?)` | `baseRepo.delete(id, tx)`. Hard delete: the FK cascade removes the child. Soft delete: the base's `deleted_at` is set and the child leaves scope through the `EXISTS` (§2.3). | 1 |

Why the base write goes through the base **repository** and not a raw insert: `stampTenant` and `withTimestamps`
apply with the base's own behaviors (`base-repository.ts:433-435`). The child repository gets the base repository
injected. A repository taking a second injected dependency has precedent (`repository.ejs.t:231-234`), and services
already take composed repositories (`service.ejs.t:74`).

Both rows are stamped with the same ambient tenant in the same transaction, so they agree before the FK checks them.

**Guards on the base.**

- The base **repository's** `create` and `upsertByNaturalKey` refuse a `kind` that has a child table
  (`KindRequiresChildError`, naming the child's service method, e.g. `MeetingService.create`). The repository is the
  one owner of both kind invariants (D16, §11.3). Base-only kinds are created normally. These are domain errors: the
  base's HTTP create DTO only accepts base-only kinds (§5), so the DTO refuses the request first (D12). If every kind
  has a child, the base gets no create use case.
- `communicationRepo.update` refuses a `kind` key (`KindImmutableError`). The database refuses the same change for
  any row that has a child.
- Updating base fields or deleting through the base is allowed for any kind. A delete through the base cascades.

**Changing a row's kind is refused.** A meeting does not become an email. Delete and create. ADR-044 §3 already puts
workflows like "convert" in a hand-written use case.

ADR-021 still holds: under `soft_delete` the cascade never fires, because `delete` is an `UPDATE`.

### 4.2 Upsert by natural key

The first consumer loads provider objects through a pivot: the raw object lands first, then a write upserts the
model row on `(source, external_id)`. That write spans both tables, whether or not the child is
`pattern: Integrated`. Without it v1 cannot load a meeting or an email, so it is in v1.

**Declared once, on the base:** `natural_key: true` on one `unique_indexes` entry (R11). It emits
`upsertByNaturalKey` on the base repository and on every child's.

| Step | Statement |
|---|---|
| 1. Base | `INSERT INTO communications (…) VALUES (…) ON CONFLICT (tenant_id, source, external_id) DO UPDATE SET … RETURNING *, (xmax = 0) AS created` |
| 2. Guard | If the returned `kind` is not the child's, throw `KindMismatchError`. The transaction rolls back. |
| 3. Child | `INSERT INTO meetings (id, tenant_id, …) VALUES (…) ON CONFLICT (id) DO UPDATE SET … RETURNING *` |

Two statements, one transaction, opened when no `tx` is passed. The result is `{ row: MeetingFlat, created }`.

- **What `SET` carries:** the columns the input carries, plus `updated_at`. Never `id`, `kind`, the tenant column,
  the natural-key columns or `created_at`. A key absent from the input is left alone, and an explicit `null` clears.
- **Tenant.** Both rows go through `stampTenant`. The conflict target is tenant-prefixed because the index is
  (`cols = tenantScoped ? [tenant, ...fields]`, `entity-locals.js:1026-1110`), so one tenant's upsert cannot touch
  another's row.
- **Kind.** An existing row with that natural key and another kind is an error, not an update. The kind FK would
  refuse the child insert anyway. The guard names the cause.
- **A soft-deleted match** is updated and stays deleted. Reviving a row is the caller's decision (OQ-14).
- **`match:` columns** are filled as in `create` (§2.4).
- **Events.** The service emits `created` or `updated` from the `created` flag, under both names (§5). No per-field
  change events, because there is no pre-read.
- **On the base**, the base repository's `upsertByNaturalKey` refuses a kind that has a child table, as its `create`
  does (`KindRequiresChildError`; the repository owns both kind invariants, D16). Base-only kinds upsert through it.

The single-table half is #780's `upsertByNaturalKey`, built here for one shape: one row, "set what the input
carries". #780 keeps the batch form and the update policies (overwrite, coalesce, keep-first).

**How it relates to `integrationUpsertOne`.**

| | `integrationUpsertOne` | `upsertByNaturalKey` |
|---|---|---|
| Declared by | `pattern: Integrated` (implies `external_id_tracking`) | `natural_key: true` on a unique index |
| Conflict target | `(tenant, provider, external_id)` (`integrated-entity-repository.ts:265-270`) | the declared columns, tenant-prefixed |
| Tables | one | base, then child |
| Foreign keys | resolved from a parent's external id (`fkResolvers`, `integration-upsert-config.ts:29-38`) | the caller passes ids |
| EAV, projection, tombstone | yes (`integrated-entity-repository.ts:75-148`) | no |
| Caller | the generated sink (RFC-0002) | a hand-written pivot or use case |

**`Integrated` on a child** stays refused in this build, and is no longer blocked by design. Once
`upsertByNaturalKey` exists, a child's `integrationUpsertOne` is a thin adapter: resolve the FKs, then delegate.
It needs the base to carry `external_id_tracking` with `(provider, external_id)` as its natural key (R11 as built
in S1 accepts only declared fields and `belongs_to` foreign key columns in a natural key, so S7 must extend it to
accept the behavior columns `provider` and `external_id`), and
`findByExternalIdProjected` / `softDeleteByExternalId` to forward to the base. That is one follow-up slice (§13,
S7), left out of v1 because the first consumer writes through the pivot, not the sink.

## 5. DTOs, Zod and events

**Child DTOs are flat.** The base's schemas are the owner, and the child extends them:

```ts
// modules/meetings/dto/create-meeting.dto.ts
import { createCommunicationSchema } from '../../communications/dto/create-communication.dto';

export const createMeetingSchema = createCommunicationSchema
  .omit({ kind: true })                          // the child fixes it
  .extend({
    title: z.string(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date().nullable().optional(),
    link: z.string().nullable().optional(),
  });

// update: createMeetingSchema.partial(), as dto/update.ejs.t:9 does today

// modules/meetings/dto/meeting-output.dto.ts
export const meetingOutputSchema = communicationOutputSchema.extend({
  kind: z.literal('meeting'),
  title: z.string(),
  /* … */
});
```

The base keeps its ordinary DTOs with two changes: the create schema's `kind` is `z.enum([<base-only kinds>])`, and
there is one extra output for cross-kind reads:

```ts
export const communicationOfKindSchema = z.discriminatedUnion('kind', [
  communicationOutputSchema.extend({ kind: z.literal('meeting'), meeting: meetingOwnOutputSchema }),
  communicationOutputSchema.extend({ kind: z.literal('email'), email: emailOwnOutputSchema }),
  communicationOutputSchema.extend({ kind: z.literal('message') }),
]);
```

The child's HTTP routes return the flat shape: `GET /meetings/:id` uses `findWithBase`, `GET /meetings` uses
`listKind`. Include allowlists (`api.includes`, charter I6) apply unchanged. `communication` never needs to be
allowlisted on the child, because it is already in the body.

**Lifecycle events: both names, one write.** `BaseService` emits after `repository.create/update/delete`
(`runtime/base-classes/base-service.ts:141-199`). With the pair write inside the repository, the child service emits
`meeting.created` with the flat snapshot and nothing else changes. The proposal adds the base name too:
`communication.created` with the base slice, so a subscriber to all kinds gets one stream. That is a small
`BaseService` change (an optional `baseEntityName`). Two more:

- `update` reads the row before the write to diff it (`base-service.ts:162`). For a child that read must be the flat
  row, or every base field looks changed. Extract the read into a protected method the child service overrides.
- A delete through the **base** emits `communication.deleted` only. The cascade is silent.

An upsert emits `created` or `updated` under both names, without per-field change events (§4.2).

Typed events (`emits:`, EVT-7) are unchanged: the use case publishes inside its transaction, and payload expressions
see the flat entity.

## 6. Base-class methods

`BaseRepository` cannot type an include (TS2536, `base-repository.ts:264-267`), so the split follows READ-1's:
mechanics in the runtime, typed signatures in the generated class.

**Shared runtime**, new `runtime/base-classes/inheritance.ts`:

```ts
/** Hoist a to-one relation's columns to the root. Pure. */
export function flattenBase<R extends Record<K, object>, K extends keyof R & string>(row: R, baseKey: K): Flattened<R, K>;
export type Flattened<R, K extends PropertyKey> = Omit<R, K> & (K extends keyof R ? R[K] : never);

/** Split a flat input into the base's slice and the child's. Pure. */
export function splitByOwner<T extends object>(input: T, baseKeys: ReadonlySet<string>): { base: Partial<T>; own: Partial<T> };

/** Narrow a base row read with its children to the union. Throws OrphanBaseError. */
export function asKind<U>(row: object, discriminator: string, childKeyByKind: Readonly<Record<string, string>>): U;

export class KindImmutableError extends Error {}
export class KindMismatchError extends Error {}
export class KindRequiresChildError extends Error {}
export class OrphanBaseError extends Error {}

/** `tx ? fn(tx) : db.transaction(fn)` — the pair writes' transaction rule. */
export function inTransaction<T>(db: DrizzleClient, tx: DrizzleTx | undefined, fn: (tx: DrizzleTx) => Promise<T>): Promise<T>;
```

`ScopeConfig` gains the optional base scope (§2.3) in `scope-filters.ts`. `BaseService` gains `baseEntityName` and
the overridable pre-update read (§5).

**Generated on the child repository** (`repository.ejs.t`):

```ts
/** The pair write. Overrides BaseRepository.create. */
override create(input: MeetingCreate, tx?: DrizzleTx): Promise<MeetingFlat>;          // "createWithBase"
/** Overrides BaseRepository.update. Throws KindImmutableError. */
override update(id: string, patch: MeetingUpdate, tx?: DrizzleTx): Promise<MeetingFlat>; // "updateAcross"
/** Overrides BaseRepository.delete. Deletes the base row. */
override delete(id: string, tx?: DrizzleTx): Promise<void>;

/** Base on its natural key, then child on id. One transaction (§4.2). */
upsertByNaturalKey(input: MeetingCreate, tx?: DrizzleTx): Promise<{ row: MeetingFlat; created: boolean }>;

/** findById with the base included, flattened. `with` and `columns` still apply to the child. */
findWithBase<W extends MeetingInclude = MeetingNoInclude, C extends MeetingColumns | undefined = undefined>(id: string, opts?: ReadOptions<W, C>): Promise<MeetingFlat<W, C> | null>;
findManyWithBase<W extends MeetingInclude = MeetingNoInclude, C extends MeetingColumns | undefined = undefined>(ids: readonly string[], opts?: ReadOptions<W, C>): Promise<Array<MeetingFlat<W, C>>>;

export type MeetingFlat<W extends MeetingInclude = MeetingNoInclude, C extends MeetingColumns | undefined = undefined> =
  Flattened<MeetingResult<W & { communication: true }, C>, 'communication'>;
```

The brief's `createWithBase` and `updateAcross` are the overrides of `create` and `update`, on purpose. A separately
named method would leave the inherited `create` in place, writing a child row with no base. Overriding removes the
wrong path. Whether the widened parameter and return types satisfy `IBaseRepository` (`base-service.ts:39-56`) under
a consumer tsconfig has to be measured, not assumed (charter I9).

**Generated on the base repository:**

```ts
/** Base rows with each row's child, narrowed by kind. One statement. */
findAllKinds(query?: ListOptions<typeof communications> & { kinds?: readonly CommunicationKind[] }): Promise<CommunicationOfKind[]>;
findKindById(id: string): Promise<CommunicationOfKind | null>;

/** One kind, flat, filtered and sorted on base columns. `CommunicationFlatByKind[K]` is `Flattened<Communication & { <child key>: Child }, '<child key>'>`. */
listKind<K extends keyof CommunicationFlatByKind>(kind: K, query?: ListOptions<typeof communications>): Promise<Array<CommunicationFlatByKind[K]>>;
countKind(kind: CommunicationKind, where?: RowFilter<typeof communications>): Promise<number>;

/** Base rows whose kind has a child table but no child row. An integrity check for jobs and tests. */
findOrphans(opts?: { limit?: number }): Promise<Communication[]>;

/** One statement, ON CONFLICT on the natural key. Emitted when the entity declares one. */
upsertByNaturalKey(input: CommunicationCreate, tx?: DrizzleTx): Promise<{ row: Communication; created: boolean }>;

/** Overrides BaseRepository.update. Throws KindImmutableError on a `kind` key. */
override update(id: string, input: Partial<Communication>, tx?: DrizzleTx): Promise<Communication>;
```

The generated services forward each of these, as they forward the READ-1 reads today.

## 7. The second family, and what the first consumer shows

```yaml
# communication_part.yaml — the base
entity: { name: communication_part, plural: communication_parts }
tenant_scoped: true
discriminator: kind
behaviors: [soft_delete]
fields:
  tenant_id: { type: uuid, required: true }
  kind:      { type: enum, choices_of: communication.kind, required: true }   # message stays base-only
  sequence:  { type: integer, required: true }
relationships:
  communication:
    { type: belongs_to, target: communication, foreign_key: communication_id, on_delete: cascade,
      match: { kind: kind } }
unique_indexes:
  - fields: [communication_id, sequence]
    natural_key: true
```

```yaml
# transcript_communication_part.yaml
entity: { name: transcript_communication_part, plural: transcript_communication_parts }
inherits: { base: communication_part, as: meeting }
fields:
  text:     { type: string, required: true }
  start_ms: { type: integer, nullable: true }
  end_ms:   { type: integer, nullable: true }
relationships:
  transcript:  { type: belongs_to, target: meeting_transcript, foreign_key: transcript_id, on_delete: cascade }
  participant: { type: belongs_to, target: communication_participant, foreign_key: participant_id }
```

```yaml
# email_communication_part.yaml
entity: { name: email_communication_part, plural: email_communication_parts }
inherits: { base: communication_part, as: email }
fields:
  text: { type: string, nullable: true }       # own text, or null when the part is a quote
relationships:
  resolves_to: { type: belongs_to, target: email, foreign_key: resolves_to_email_id, nullable: true }
```

What this family shows:

- **Typed links between kinds are plain `belongs_to`.** `resolves_to_email_id → emails.id` can only point at an
  email, because `emails` only holds emails. This is geoabacus's `Neighbourhood.hierarchy_parent_id → locality.id`,
  and it needs nothing new.
- **"Any kind" is a plain `belongs_to` to the base.** `communication_participant.communication_id →
  communications.id`.
- **A rule that ties one family's kind to another's is `choices_of:` plus `match:` on the discriminator** (§2.4,
  case 1). The part's kinds are the communication's kinds, and one composite FK makes them agree.
  `communication_participant.role` is case 2 of the same section.
- **A part upserts on `(communication_id, sequence)`.** The pair upsert is not specific to provider ids (§4.2).

## 8. Limitations

**What Drizzle cannot do.** No inheritance mapping: `defineRelations` has `one` and `many` and nothing else. No
polymorphic identity map, no subclass instances, no lazy attribute load. A "meeting" in TypeScript is a plain object
whose type was computed by the generator.

**What Electric clients do themselves.** Base and child are two shapes, and a child's shape still holds rows whose
base is soft-deleted. Clients read a child through its base. §3.4 says what the generated graph gives for that join
and what v1 adds. A cross-kind list on the client is hand-written in v1.

**Cost.**

| Operation | Cost |
|---|---|
| Child read, table-shaped | 1 statement, 1 table. Plus a primary-key `EXISTS` on the base when the base has `soft_delete` or `user_tracking`. |
| Child read with base, nested or flat | 1 statement, one primary-key lateral join. |
| Cross-kind read | 1 statement, one primary-key lateral join per child kind requested. |
| Create | 2 inserts in 1 transaction. The base insert maintains 1 extra unique index (2 when tenant-scoped). |
| Upsert | 2 statements in 1 transaction. |
| `match:` | One derived column per matched column, one unique index on the target, and a scalar subquery on the parent's primary key inside the insert. |
| Update | 1 or 2 updates in 1 transaction, plus the pre-read events already do. |
| Delete | 1 statement. |
| Storage | Per child row: `kind` (4 bytes) and the tenant column (16 bytes). Per base: 1 or 2 extra unique indexes. |

**Not enforced by the database:** completeness (§2.2). An orphan base row is prevented by the generated write path
and found by `findOrphans()`.

**No single read filters on base columns and sorts on child columns**, or the reverse. Root the read at the table
that owns the sort key and filter the other side with a hand-written `EXISTS`. A generated two-table filter is a
follow-up.

**Refused in v1:**

- Multi-level inheritance, and more than one base.
- Changing a row's kind.
- A non-`uuid` or composite key. The generator emits one key shape (`entity.ejs.t:32`).
- `eav: true` and `pattern: Junction` in a family (R9), and `eav_value_table: true` on a child (a child-only refusal, not R9).
- `pattern: Integrated`, `surface:`, `integration:` or `detection:` on a child. The integration upsert's conflict
  target and write columns are one table's (`repository.ejs.t:216-227`). v1 loads a family through
  `upsertByNaturalKey`; the sink adapter is a follow-up slice (§4.2).
- A nullable tenant column on a `tenant_scoped` base (R10).
- #787's implicit same-tenant FK (OQ-12), and all of #786: the user-facing `checks:` key and `min` / `max` emission.
- An `on_delete` option, child-declared lifecycle behaviors, and child `queries:` by a base column.
- The semantic model. Both edges are to-one, so they add no fan-out, but whether a child's measures see the base's
  dimensions is not designed here.

**Migrating from the composition workaround.** There are no host apps, so there is no migration command. The recipe,
for a child `meetings(id, communication_id unique, …)`: repoint every FK that references `meetings.id` to the
`communication_id` value; drop the old `id`; rename `communication_id` to `id` and make it the primary key; add
`kind` with its default and CHECK; add the tenant column, NOT NULL; add the base's unique indexes; add the composite FKs. drizzle-kit will read the
key change as drop-and-add, so write this migration by hand.

## 9. Alternatives

### 9.1 SQLAlchemy 2 mapping

What `app/models.py` uses, and what it becomes here.

| SQLAlchemy 2 | In geoabacus | Here | Reproduced? |
|---|---|---|---|
| `polymorphic_on` | `"placetype"` on `Shapefile` (and repeated on each child) | `discriminator: kind` on the base, once | Yes. |
| `polymorphic_identity` | `"neighbourhood"`, `"locality"`, … | `inherits.as`, default the entity name | Yes, and stronger: a CHECK and an FK enforce it. SQLAlchemy trusts the mapper. |
| Child `id = ForeignKey('shapefile.id'), primary_key=True` | every child | The same DDL | Yes. |
| Querying the base returns subclass instances | `Shapefile` query → `Neighbourhood` objects | `findAllKinds()` → a discriminated union of plain objects | Partly. Typed and exhaustive in a `switch`. No classes, so a method like `to_geojson` becomes a function over the union. No identity map. |
| `with_polymorphic(Base, [A, B])` | not used | `findAllKinds({ kinds })`, or `with: { meeting: true, email: true }` | Yes. One statement, lateral joins instead of flat `LEFT JOIN`s. |
| `selectin_polymorphic` | not used | Not in v1 | No. It is 1 + K statements, which breaks the one-statement rule (charter I4). Add it only if a wide family measures badly. |
| Child exposes base columns as its own attributes | `Neighbourhood(...).geometry` | `MeetingFlat` through `flattenBase` / `findWithBase` | As a projection of a read. The table type stays the table. No lazy load. |
| One insert or delete spans both tables (unit of work) | `db.session.add(Locality(...))` | The child repository's `create` / `delete` in one transaction; delete by cascade | Yes, written out. |
| Typed link between kinds | `hierarchy_parent_id → locality.id` | `belongs_to` targeting a child entity | Yes. Works today. |
| A relationship that returns subclass instances | n/a | `with: { communication: { with: { meeting: true } } }` then `asKind` | Partly. The caller asks for the children it wants. |

Two things the reference shows. `create_shapefile` passes `placetype=` and picks the class in the same `match`: the
two agree by convention, and nothing in the database stops a `neighbourhood` row under a `county` shapefile. And
`name` is declared on all five children while `Shapefile.to_geojson` reads `self.name`, which only works because
every instance is a subclass. A field every kind has belongs on the base, and R4 plus flat DTOs make that the easy
path.

### 9.2 Same storage, no mapper

The storage is SQLAlchemy 2's. The mapper is not reproduced, for three reasons:

1. **Drizzle gives nothing to build one on.** The typed read surface is generated per table because the base class
   cannot type an include at all (`base-repository.ts:264-267`). A polymorphic loader would be a second query engine
   beside READ-1, with its own scope handling.
2. **The frontend never sees objects.** Electric syncs tables, and the client projects from the same declared graph
   (ADR-044 §"Fate of the Electric-parity rationale"). A table-shaped contract with two relation edges is the one
   shape both sides can share. A backend-only object model would be a second description of the domain.
3. **A generator can make the explicit form free.** What the mapper hides (two inserts, a join, a narrowing step) is
   emitted here, typed and checked by the database.

### 9.3 Rejected

| Alternative | Why not |
|---|---|
| Single-table inheritance (one wide table, nullable columns, CHECKs per kind) | One Electric shape, but `meeting_transcript → meeting` can no longer be a plain FK to "a meeting". Every kind-specific referrer needs a composite FK, and every kind-specific column is nullable with a CHECK. |
| Concrete-table inheritance (no base table) | "Any kind" becomes a `one_of:` at every referrer, and a cross-kind read is a `UNION`. Electric has no views. |
| Composition (today's workaround) | Two ids, no kind integrity, nothing generated knows the pair. |
| Trigger for kind integrity | §2.2 option B: a second migration channel. |
| Generated column for the child's `kind` | Not published over logical replication before Postgres 18. |
| No tenant column on the child (scope by `EXISTS` on the base) | A join on every child read and hop, and no column for a shape proxy to filter. |
| Pair write in the use case (the EAV precedent, `use-cases/create.ejs.t:57-58`) | A hand-written caller of `service.create` would write a child with no base. The repository override leaves no wrong path. |
| A flat read on the core builder (`innerJoin`) | A second execution path beside RQBv2, with no `with` on it. READ-1 §3.1 chose one path. |

## 10. What changes in the generator

The summary. §13 is the build plan, slice by slice.

| # | Item | Where |
|---|---|---|
| 1 | Keys: `inherits:`, `discriminator:`, `match:` on a relationship, `natural_key:` on a unique index, `choices_of:` | `src/schema/entity-definition.schema.ts` (`:208`, `:451`, `:1141-1368`) |
| 2 | Rules R1 to R11 and M1 to M5 | single-file rules in `src/schema/inheritance.ts`; cross-entity rules in new `src/parser/validate-inheritance.ts` |
| 3 | Child `id` line; `foreignKey` + `check` in the extra-config list; base and target unique indexes; derived tenant and `match:` columns | `entity.ejs.t:32`, `:41`; `entity-locals.js:761`, `:2168` |
| 4 | Two edges per child with the `inherits` marker; base scope on `ScopeConfigLiteral` | `src/emitters/relations/build-graph.ts`, `types.ts`, `emit-manifest.ts` |
| 5 | `inheritance.ts`; base scope in `scopeFilter`; `BaseService` event changes | `runtime/base-classes/` |
| 6 | Repository overrides, typed reads, `upsertByNaturalKey`; service forwarders; base repository injection | `repository.ejs.t`, `service.ejs.t`, `module.ejs.t` |
| 7 | Flat DTOs; base union output; base create restricted to base-only kinds | `dto/*.ejs.t` |
| 8 | Child find and list use cases return flat rows; controller output | `use-cases/find-by-id.ejs.t`, `list.ejs.t`, `controller.ejs.t` |
| 9 | Frontend: inner-joined child-to-base hop; `<child>WithBase` query and hooks | `src/emitters/frontend/graph-model.ts`, `emit-graph.ts` |
| 10 | Studio: one row in each vocabulary table | `tools/studio/src/inspector/relationship-kinds.ts`, `tools/studio/src/graph/edge-kinds.ts` |

## 11. Decisions and open questions

### 11.1 Decided (Doug, 2026-11-13)

| # | Question | Decision |
|---|---|---|
| OQ-1 | Key names | `inherits:` on the child, `discriminator:` on the base. |
| OQ-2 | Kind integrity | Composite FK, with a `kind` column on the child. |
| OQ-3 | Tenant on the child | Column on the child, pinned by a composite FK now. `inherits:` requires the base's tenant column to be NOT NULL (R10), so the FK is always enforced. |
| OQ-4 | Child DTO and HTTP shape | Flat. |
| OQ-5 | Cross-kind row shape | The child is nested under its relation key. (Revised at Gate 2.5, D11: the key differs from the kind key whenever `as:` is used.) |
| OQ-6 | Lifecycle events | Both names: `meeting.*` (flat) and `communication.*` (base slice). |
| OQ-7 | Provider sync | The pair upsert, `upsertByNaturalKey`, is in v1 (§4.2). `Integrated` on a child is a follow-up slice. |
| OQ-8 | Orphan base rows | Service guard plus `findOrphans()`. The consumer's pivot writes inside one transaction. |
| OQ-9 | Discriminator choices | Listed on the base. |
| OQ-14 | Upserting onto a soft-deleted row | Update it, leave `deleted_at`. A provider re-sending an object is not a decision to undelete it. Confirmed by Doug at Gate 2.5 (2026-11-15, D8); built in S4. |
| — | #787 | `match:` lands in this build (§2.4). |
| OQ-11 | The "part kind fits communication kind" rule | `communication_part.kind` is `choices_of: communication.kind` and its `belongs_to` carries `match: { kind: kind }`: one composite FK, under M2's discriminator exception. No derived `communication_kind` column and no CHECK. The user-facing `checks:` key leaves this build and stays whole in #786; the child's `kind` CHECK uses an internal builder. |

### 11.2 Open — raised by revision 2

Each of these is scope this revision pulled in to satisfy the answers above. Each has a default the plan assumes.

| # | Question | Default | Alternative | Cost to switch later | Recommendation |
|---|---|---|---|---|---|
| OQ-10 | How the natural key is declared | `natural_key: true` on a `unique_indexes` entry | A top-level `natural_key: [fields]` that emits its own index (#780's proposal) | A schema rename before anything ships. | Default. The index is already declared in `unique_indexes`, and one entry cannot be declared twice. This settles #780's first open question, so say so there. |
| OQ-12 | #787's implicit same-tenant FK on every tenant-scoped `belongs_to` | Stays in #787 | Build it here | It changes the DDL of every tenant-scoped relationship and needs a NOT NULL tenant on every entity, not only on bases. | Default. This build gives #787 its emitter and its `match:` form. The default-on rule is its own decision. |
| OQ-13 | Sharing an enum type across entities | `choices_of: <entity>.<field>` | Make the lookup's `kind` a `match:` column against a kinds table | A field-option rename before anything ships. | Default. Without one of them, case 2's FK cannot be built. |

### 11.3 Decided at Gate 2.5 (Doug, 2026-11-15)

Seventeen items the Gate 2.5 reviews marked `DECISION`. Each was decided as the coordinator recommended.

| # | Question | Decision | Landed in |
|---|---|---|---|
| D1 | A child declares a pattern with no `columnsRead`: checked or not? | R6 fails closed. A pattern other than `Base`, or a capability, with no `columnsRead` is an R6 error naming it; `columnsRead` is added to `CapabilityPatternDefinition`. | S1 |
| D2 | A derived `match:` column is "read-only in the output" (§2.4), but the output DTO does not carry it. | Delete the sentence. The column is not emitted in the output DTO. | S1 (§2.4), S2 |
| D3 | The 63-byte constraint-name check is claimed for "every name". | Narrow it to the names the extra-config callback declares. Explicit FK names are #921's. | S1 (§2), S2 |
| D4 | No base-only kind is covered on a soft-delete family. | A scaffold-only `document` family (`memo` base-only, `report` child) covers it in reads, writes and HTTP. | S3, S4, S5 |
| D5 / D6 | The no-name-derivation lint misses `.charAt(0).toLowerCase()` and `.toUpperCase().replace(`; two helper-name sites are deferred. | Widen the lint; derive every remaining #875 site through `src/derived/api/names.ts`. A hit already on `main` gets an issue and a named expectation. The allowlist never grows. | S5 |
| D7 | S4 touched the Integrated / Metadata repositories (`deriveColumns`) and S3's `<Child>Flat` alias. | Ratified as two scope exceptions; S4's "Must not touch" line names them. | S4 |
| D8 | OQ-14: upsert onto a soft-deleted row. | Confirmed: update it, leave `deleted_at`. Moved to §11.1. | S1 |
| D9 | Composing modules import their home modules instead of providing the repository. | Ratified. Every composing module imports the home module, all via `forwardRef`. | S4 |
| D10 | S2's "`natural_key:` alone changes no emitted byte" assertion changed. | Ratified: the new form asserts the exact set of differing files. | S4 |
| D11 | OQ-5: nested under the kind key or the relation key? | The relation key. §11.1's row is edited. | S1 |
| D12 | `KindRequiresChildError`, `KindImmutableError` and `KindMismatchError` cannot reach an HTTP client: the DTO refuses or strips `kind` first, so the controller's mapping is dead code, and `createPath` handed in-process callers an HTTP route. | They are domain errors only: the controller's unreachable mapping goes; the DTO's zod issue refuses the request; `createPath` names the child's service method. | S5 |
| D13 | The Studio writes-off test dropped its `origin.text` assertions. | Restore them with the current chip text. | S5 |
| D14 | The client shows a child whose base is soft-deleted. | The client hides it: `<plural>WithBase` and the child-to-base root hop filter `deletedAt` when the base has `soft_delete`. | S6 |
| D15 | A lib global in value position (`Map`, `URL`) in the emitted frontend. | `globalThis.*` across the emitted frontend; the `values` hygiene rule runs over the whole tree. | S6 |
| D16 | Where "a kind with a child table is written only with its child row" lives. | Both kind invariants live in the repository, the one owner of the pair write. | S4 |
| D17 | At S4's tip alone, the base's write routes return the new kind errors as 500s. | No change in S4. S5 settles what HTTP sees (D12), and the stack lands atomically. | — |

## 12. The issue (filed as #875)

**Title:** `inherits:` — joined-table inheritance in entity YAML, with `match:` composite FKs (RFC-0006)

**Body:**

Entity YAML cannot say that one entity is a kind of another. The workaround, a child with its own id and a unique
`belongs_to`, gives two ids per row, no kind integrity and no generated code that treats the pair as one thing.

RFC-0006 (`docs/rfcs/RFC-0006-joined-table-inheritance.md`) designs `inherits:` on a child and `discriminator:` on
the base. The child's primary key is a foreign key to the base row. A composite FK `(id, kind)` with a fixed `kind`
on the child makes the database refuse a child under a base of another kind. Reads stay on the READ-1 surface, with
the base as a relation and a flat projection. The child repository's `create`, `update` and `delete` write both rows
in one transaction, and `upsertByNaturalKey` upserts both on the base's declared natural key.

The same build adds `match:` on a `belongs_to` (#787's explicit form), `choices_of:` (one enum type across entities),
and `natural_key: true` on a unique index (the single-row half of #780), because the first consumer's model needs all
three. §13 of the RFC is the build plan.

**Acceptance:**

- [ ] **A1** `inherits:`, `discriminator:`, `match:`, `natural_key:` and `choices_of:` validate. Rules R1
      to R11 and M1 to M5 each fail with a message naming the entities involved.
- [ ] **A2** The fixture family (§13.1) generates and passes `tsc` in `just test-baseline` and `just test-smoke`.
- [ ] **A3** Emitted DDL: the child `id` has no default; the kind FK, tenant FK and kind CHECK are present; the base
      has both unique indexes; the child's tenant column is NOT NULL.
- [ ] **A4** Integration: inserting a child under a base of another kind fails with `23503`; updating `kind` on a
      base row that has a child fails; a hard delete of the base removes the child.
- [ ] **A5** `match:` emits one composite FK and the target's unique index. Integration: a `transcript` part under
      an `email` communication is rejected; a participant with a role of another kind is rejected; the matched
      column is filled by the insert, not by the caller.
- [ ] **A6** Child `create` writes both rows in one transaction and rolls both back on failure; `update` across
      both tables bumps the base's `updated_at`; a `kind` in an update payload throws `KindImmutableError`.
- [ ] **A7** `upsertByNaturalKey` twice with one key leaves one base row and one child row, and the second call
      reports `created: false`. A key that exists under another kind throws `KindMismatchError` and writes nothing.
      One tenant's upsert never touches another tenant's row with the same key.
- [ ] **A8** With `soft_delete` on the base, a soft-deleted row's child is absent from child reads and from a hop
      into the child. With `tenant_scoped`, another tenant's child is absent at the root and at a hop.
- [ ] **A9** `findAllKinds` is one statement (`.toSQL()` in `just test-unit`), returns the union, and throws
      `OrphanBaseError` on a base row with a missing child. `findOrphans` returns that row.
- [ ] **A10** Child DTOs are flat; the child's HTTP routes return the flat shape; the base's create accepts only
      base-only kinds.
- [ ] **A11** A child write emits its lifecycle event under both the child's name and the base's.
- [ ] **A12** The relations manifest and the frontend graph descriptor carry both edges
      (`src/__tests__/emitters/frontend/graph-golden.test.ts`).
- [ ] **A13** The frontend emits `<child>WithBase` (query and hooks) with an inner join, and
      `test/smoke/fixtures-frontend/usage/` assigns from it under `just test-smoke-frontend`.
- [ ] **A14** Studio shows the inherits edge from its two vocabulary tables (`just test-studio`).
- [ ] **A15** Each new gate can fail on its own subject: remove the kind FK from the template and A4 goes red;
      remove the inner join and A13 goes red.
- [ ] **A16** CLAUDE.md, `consumer-skills/entities/yaml-reference.md` and this RFC say what was built. #780, #786
      and #787 each get a comment saying which part landed here and what remains.

**Relations:**

- **#783** — a new sub-issue of the expressiveness epic: a constraint shape (shared primary key, composite FK) the
  YAML cannot express today.
- **#787** — its explicit form, `match:`, and its `foreignKey` emitter land here. The implicit same-tenant default
  stays there.
- **#786** — not built here. The child's `kind` CHECK uses an internal check builder that #786's `checks:` key can
  reuse; the key itself and `min` / `max` emission stay there (OQ-11).
- **#780** — `natural_key: true` and a single-row `upsertByNaturalKey` land here. The batch form and update policies
  stay there.
- **#788** — the alternative, not a dependency. `one_of:` is for a row pointing at one of several unrelated
  entities; `inherits:` is for entities that are one thing. The RFC's "When to use it" section is the rule.
- **#812** — `entity_ref` is the no-FK form this replaces for "any kind" pointers.

## 13. Implementation plan

For the agents who build this. Work from this RFC and the issue. Read `CLAUDE.md` first: its rules bind every
slice.

### 13.1 The fixture family

Every slice tests against the same entities. They are the ones this RFC draws, with generic fields. Do not copy
names or fields from any host application (this repository is public).

| Entity | Role in the tests |
|---|---|
| `communication` | Base. `tenant_scoped` with a declared NOT NULL `tenant_id`, `timestamps`, `discriminator: kind` with `[meeting, email, message]`, natural key `(source, external_id)`. No `soft_delete`: the tenant-only scope path. |
| `meeting`, `email` | Children. `message` stays a base-only kind. |
| `email_thread`, `meeting_transcript` | Plain entities a child points at and is pointed at by. |
| `communication_part` | Second base, **with `soft_delete`**: the `EXISTS` scope path. `kind` is `choices_of: communication.kind` with `match: { kind: kind }` to `communication` (§2.4 case 1), natural key `(communication_id, sequence)`. |
| `transcript_communication_part`, `email_communication_part` | Its children. The second has a typed link to `email`. |
| `communication_participant_role`, `communication_participant` | `choices_of:` and two `match:` relationships on one column. |
| `communication_note` | A `match:` whose every FK is nullable: the derived column is nullable and the entity carries a CHECK per FK, `<fk> IS NULL OR <derived> IS NOT NULL` (not NULL-together). |

Where they live, and when:

| Location | Contents | Added in |
|---|---|---|
| `test/fixtures/inheritance/entities/` (new) | The whole family. Loaded by unit tests through the real loader. Never generated from. | S1 |
| `test/fixtures/entities/` (baseline) | `communication`, `meeting`, `email`, and the two plain entities they need: `email_thread`, `meeting_transcript` (a `has_many` onto a missing entity types a `with` the manifest does not have) | S2 |
| `test/scaffold/entities/*-scaffold.yaml` (integration) | The whole family | S2 |
| `test/smoke/fixtures/` (`just test-smoke`, default scenario) | The whole family. The smoke sets `tenancy.column: organization_id` project-wide, so its three tenant-scoped entities spell `tenant_scoped: { column: tenant_id }` | S2 |
| `test/smoke/fixtures-frontend/entities/` | `communication`, `meeting`, both `sync: electric` | S6 |

The harness sets are separate directories by design. Keep the copies field-identical.
`src/__tests__/fixtures/inheritance-fixtures-agree.test.ts` parses all four locations and fails when a shared
entity differs (it compares `tenant_scoped` as the column it resolves to under each location's own `tenancy.column`, so only the spelling may differ, never whether the entity is scoped). The fixture family's
plain target entity is `party` (relationship `party`, column `party_id`), not `person`: the baseline set already has
a different `person`.

### 13.2 Slices

Dependency order: S1 → S2 → S3 → S4 → S5 → S6. S6's Studio part needs only S1. Land the stack together (one
`gh stack`, atomic merge), with each PR green on its own.

**S1 — Schema and validation.**

- Touches: `src/schema/entity-definition.schema.ts` (field options `:208-258`, `RelationshipSchema` `:451-475`,
  `unique_indexes` `:1329-1366`, top-level keys `:1141-1368`); `src/schema/entity-definition.schema.json`; new
  `src/parser/validate-inheritance.ts`, exported from `src/parser/index.ts` and called in the `entity new` pre-flight
  beside `validateSemanticModel` (`src/cli/commands/entity.ts:45`); `src/schema/tenancy.ts` (R10, and deriving a
  child's tenancy from its base); tests under `src/__tests__/schema/` and `src/__tests__/parser/`; the fixture
  directory.
- Must not touch: `templates/`, `runtime/`, `src/emitters/`. The generator accepts the keys and emits nothing new.
  An entity that uses `inherits:` is refused at generation with "not implemented until S2", so no half-built table
  can be emitted.
- Gates: `bun run typecheck`, `just test-unit`. `just test-baseline` is byte-identical.
- Closes: A1.

**S1 as built (2026-11-13).** What the build settled, beyond the plan above:

- **Where each rule runs.** Single-file rules (R1's own-file half, R3's discriminator half, R5, R9, R11, §8's
  refusals, M1's "belongs_to only") are a refinement on `EntityDefinitionSchema` through
  `src/schema/inheritance.ts`. Cross-entity rules (R1's `choices_of:` target, R2, R3's base half, R4, R6, R7, R8,
  R10, M1–M5) are `validateInheritance` in `src/parser/validate-inheritance.ts`, called from `entity new`'s
  pre-flight (`preflightEntityTargets`, so `--all`, a single target and `junction new` all see it) and from
  `analyzeDomain` (so `entity validate` and `project inspect --kind analyze` report the same errors). The
  validator reads `ParsedEntity`, the model S3's `build-graph` reads. `inherits`, `discriminator`,
  `sync`, a field's `choicesOf` and a relationship's `match` / `nullable` / `onDelete` are carried onto it, so
  the columns a `roles:` entry derives (`<role>_<target>_id`) are visible to M2 and R4, and the directory is
  loaded once.
- **R10 and a child's tenancy** are in `src/schema/tenancy.ts`: `baseTenantColumnIssue` and `resolveChildTenancy`
  (column, `tenantScoped`, strict enforcement, all from the base). `lifecycleBehaviorsDeclared` is R5's behavior
  half and counts a behavior a pattern implies (`Integrated` implies `external_id_tracking`).
- **R1 and `choices_from:`.** A discriminator lists literal `choices:` or `choices_of:`. A `choices_from:` file is
  refused on it, because the kinds must be known when the family is validated. `choices_of:` follows exactly one
  hop: its target is an existing entity's `type: enum` field with literal `choices:`, never another `choices_of:`
  or a `choices_from:`, and never the entity's own field.
- **R4** also sees the columns a `match:` derives (a child deriving `thread_topic` collides with a base field of
  that name) and the FK columns a role derives.
- **R6** reads the columns a pattern says it reads: `PatternDefinition.columnsRead(config)`, stated next to the
  pattern's own config. `Activity` reads `occurredAt` (default `occurred_at`), `user_id` (`findByUserId`) and the
  subject column (`subjectColumn`, else `<subject>_id`); `Metadata` reads `entity_id`, `entity_type` and
  `valid_from`. A child declaring a pattern whose columns include one the base owns is an error. Config strings are
  not compared. The config is parsed through the pattern's own schema first. R6 **fails closed** (D1, §11.3):
  a child that declares a pattern other than `Base`, or a capability, with no `columnsRead` is an R6 error naming the
  pattern. `columnsRead` is on `CapabilityPatternDefinition` too: `Actor` and `Communication` state `[]` (the first
  reads its members' table through a `has_many`, the second reads role FK columns the declaring entity owns). `Knowledge`
  and `Integrated` state none, so each is refused on a child.
- **R4 and M2** see the columns a pattern contributes (`PatternDefinition.columns`) as well as behavior, tenant and
  derived columns.
- **R7** covers `by`, `select` and `order` of the by-column queries and the `filters` and `search` column of a
  search query. Both shapes are on `ParsedEntity` (`queries`, `searchQueries`).
- **R8** compares **resolved** modes: `entity.sync ?? frontend.sync.mode`. The project mode reaches the validator
  as a required option (`syncMode`, resolved by the caller through `FrontendSyncConfigSchema`, as `tenancyColumn`
  is through `TenancyConfigSchema`; the validator holds no default), so a base `sync: electric` with
  undeclared children under a global `electric` is fine, and is an error under a global `api`.
- **R11** adds two refusals the rule implies: a `natural_key` entry may not have `where` (a partial index is not an
  `ON CONFLICT` target without its predicate), and its columns must be declared fields or `belongs_to` foreign
  key columns. `natural_key:` on an entity outside a family is legal.
- **§8's key refusals** include a field named `id` on a child (its key is the base row's id) and a non-`uuid` `id`
  on a base.
- **M2's exception compares SQL types, not spellings:** the discriminator is accepted when its type equals the
  target column's (`choices_of: communication.kind` against a lookup column that is also `choices_of:
  communication.kind`, or a literal `communication.kind` against one). A child's derived columns are not
  available to a match either: its base's discriminator and tenant column are columns on the child.
- **M1** takes target columns from the target's declared fields and `belongs_to` FK columns only; a behavior or
  emitted tenant column is not a match target (the tenant column is emitted nullable unless declared).
- **M4** is a write-path rule (S4). S1 enforces its one static corollary: `on_delete: set_null` on a `match:`
  relationship is refused, because Postgres would null every column of the composite key, including the matched
  one.
- **M5** surfaces two ways. The discriminator exception names a different enum than the target column's
  (`choices_of` pointing elsewhere); or one local column is matched by two relationships whose target enums are
  different Postgres types (reported as M5, not M3). A discriminator with no `choices_of:` at all is M2's
  exception unmet.
- **Generation refusal.** Until S2, an entity in the directory that uses `inherits:`, `discriminator:`, `match:`
  or `choices_of:` is a **run-level rejection** (the #666 posture): `entity new` stops before hygen, whatever
  target it was asked for and whatever `--continue-on-error` says, with "not implemented until S2 of #875". The
  barrels (`schema.ts`, `modules.ts`) and the relations manifest read the whole directory, so refusing only the
  family's own files would still emit exports and scopes for modules that were never written. A cross-entity
  violation (R1–R10, M1–M5) is a run-level rejection for the same reason. `natural_key:` alone is accepted: no emitter reads the key, and
  `src/__tests__/cli/inheritance-ddl.test.ts` asserts the generated tree is byte-identical with and without
  it.
- **`checks:`** is not a key (OQ-11). The schema is `.strict()`, so writing it is an unknown-key error.
- **The editor JSON schema.** `src/schema/generate-json-schema.ts` is a hand-kept mirror of the entity schema (it
  did not run: it imported Zod 3's root export, which has no `toJSONSchema`; it now imports `zod/v4`). It gains the
  five keys and `entity-definition.schema.json` is regenerated from it.
- **ADR-046 (phase R).** Nothing moved into `src/derived/api/`: S1 emits no generated code (no template, no
  method, use case, route or class name), and a family's refusal is a run-level rejection before hygen. The
  derivation's first consumer is S2. The rebase onto the ADR-046 `main` only reconciled `ParsedRelationship.onDelete`
  (main added it; S1 carries `nullable` and `match` beside it) and `ParsedEntity.uniqueIndexes` beside S1's
  `inherits` / `discriminator` / `naturalKey`.
- **ADR-046 Phase B (phase R2).** Rebased onto `main` with Phase B (#888–#898): no conflicts, nothing to print — S1 has no
  template, no `entity-locals.js` change and no flag local, so there is nothing to move onto `apiSurface`; the
  allowlist did not grow and generated output (`test-baseline`) is byte-identical.

**S2 — DDL: shared key, composite FKs, the child's kind CHECK.**

- Touches: `templates/entity/new/backend/entity.ejs.t` (`:32` the `id` line, `:41` the `belongs_to` column when it
  has a `match:`, `:51-57` the tenant column); `entity-locals.js` (`processBelongsTo` `:761`, enum naming
  `:590-597` for `choices_of:`, the constraint list `:2168-2223`, the builder imports `:2246`); a new
  `templates/_shared/inheritance.mjs` that reads a family and a target's referrers through `projectEntityLookup`;
  `src/cli/shared/entity-render.ts`, so rendering a child or a `match:` referrer alone also re-renders its base or
  target, as `junction new` does for a junction's parents.
- Until S4 a child gets no write use cases or routes (as `generate.writes: false`): its inherited `create` would
  insert without an `id`.
- Must not touch: `runtime/`, the repository and service templates' read and write bodies, the DTO templates
  except to drop a `match:` column from input.
- Adds: the baseline and scaffold fixtures; `test/scaffold/tests/inheritance-ddl.test.ts`, which writes with raw
  SQL and asserts the constraints (A4, A5's rejections).
- Gates: `just test-baseline` (the snapshot diff is new modules and barrel lines only; the #680 expectation is
  untouched), `just test-smoke`, `just test-integration`.
- Closes: A2 (tables), A3, A4, A5 (rejections).

**S2 as built (2026-11-13).** What the build settled, beyond the plan above:

- **Where the cross-entity reads live.** `templates/_shared/inheritance.mjs` reads whole YAML documents through
  `projectEntityLookup` (`lookup.definition(name)` / `lookup.definitions()`, added in `entity-naming.mjs`; the
  lookup used to keep only the `entity:` block). It returns data: a child's base, kind enum and tenant column
  (`resolveChildTenancy`, S1's), the `unique(id, …)` column sets a table must offer, the derived columns and
  composite FKs of its `match:` relationships, and enum references (`choices_of:` resolves one hop, to the owner's
  `pgEnum` and the path to import it). `entity-locals.js` turns that into `tableConstraints` entries and
  imports, so naming, `assertDistinctConstraints` and the by-use drizzle imports all apply to them.
- **A base or `match:` target is rendered by its own template** from its referrers' YAML. A `unique(id, kind)` is
  emitted for every discriminator, whether or not a child exists; `unique(id, <tenant>)` for a tenant-scoped base;
  one `unique(id, <cols>)` per column set a `match:` points at (deduplicated by set, so the base's `(id, kind)` is
  shared with the discriminator's). `natural_key:` needed no new emitter: it is the unique index it already was.
- **Rendering a child, or a `match:` referrer, alone also renders its base / target.**
  `inheritanceCounterparts` (`validate-inheritance.ts`) names them and `preflightEntityTargets` appends them to
  the validated targets **before** the `emits:` / `roles:` / schema checks read them, so a counterpart those reject
  stops the run before hygen writes anything, and a child (or referrer) whose counterpart is rejected is rejected
  with it, even under the default `--continue-on-error`. `entity new meeting.yaml` and `junction new`'s parent
  re-render both bring a stale base current. Only this direction exists: a base's output depends on its own YAML and
  its `match:` referrers', **not** on its children, so editing a base and rendering only the base leaves its children
  stale, as editing a `belongs_to` target leaves its referrers stale today.
- **S1's generation refusal is gone** (`unemittedInheritanceKeys`, `notGeneratedYetMessage`). A cross-entity rule
  violation (R1-R10, M1-M5) stays a run-level rejection.
- **Names.** Constraint names: `<table>_<base>_<discriminator column>_fk`, `<table>_<base>_tenant_fk`,
  `<table>_<discriminator column>_check`, `<table>_<relationship>_match_fk`, `<table>_<relationship>_match_check` (an all-nullable `match:`), `<table>_id_<cols>_uniq`. All use the
  SQL table name. A name over Postgres's 63 bytes is a generation error (Postgres would truncate it silently and
  two long names could collide).
- **A child's columns** come right after `id`: the kind (the base's `pgEnum`, imported, `.$type<'<as>'>()`), then
  the tenant column when the base is tenant-scoped. The tenant index is emitted first, like any tenant-scoped
  table's. The CHECK is `check(name, sql`${tCols.kind} = '<as>'`)` through the internal builder; `as` must be a plain
  identifier (S1's schema rule: snake_case). A child that is a base's child by `as:` of a `choices_of:` discriminator (`communication_part`'s
  children) imports the enum from its owner's leaf (`communications/communication.enums`), the base table from the base.
- **`match:` columns.** The relationship's own column loses its single-column `.references()` and its unused
  `AnyPgColumn` import. A derived column takes the target column's type (enums: the target's `pgEnum`, imported),
  is NOT NULL unless the FK resolves nullable, and is emitted once per local name (M3). It is not a field, so it is
  absent from the create and update DTOs and from the entity's own `processedFields`; it is in the table type.
  M2's exception derives nothing and the FK uses the declared discriminator column.
- **The extra-config callback parameter is `tCols` for every entity table and junction**, from one constant
  (`templates/_shared/table-callback.mjs`) that every builder reads, `renderSqlPredicate` included. A composite FK
  reads the other table's export inside the callback, and the emitted-name hygiene rule (#813) forbids a
  plural-shaped binding in such a function. (The first S2 build rewrote `t.` to `tCols.` in finished text for the
  tables that had one; that also rewrote a string literal in a user's predicate.)
- **Enums are emitted into `<entity>.enums.ts`** for every entity that declares one (see §2.1): a leaf module
  importing only `drizzle-orm/pg-core`. The entity file imports and re-exports them; every cross-entity enum
  import (a child's `kind`, `choices_of:`, a `match:` column) points at the owner's leaf module. Junction and
  relationship tables keep theirs inline: nothing imports them.
- **A name over 63 bytes is a generation error for every name an entity table's extra-config callback declares**
  (index, unique, composite FK, CHECK), not only S2's: the check is in `assertDistinctConstraints` (C5), and the
  message names `entity.table:` (TABLE-0) as the way out. Not covered: the names Drizzle derives for a single-column
  `.references()` FK, `pgEnum` type names, and junction / relationship tables. Closing that gap changes names or
  fails generation for existing long FK names, so it waits for a decision: #921 owns explicit FK names (D3, §11.3).
- **`match:` shorthand and family discovery have one owner.** `matchPairsOf` and `inheritanceCounterpartNames` are in
  `src/schema/inheritance.ts`, next to `inheritsOf`, `matchPairsOf` is read by the parsed model, the validator and the
  templates (whose reverse walk, `matchReferrers`, is separate); `inheritanceCounterpartNames` only by the
  validator. Both lookup constructors store a document for every block (`entityLookupFrom` wraps a bare block as
  `{ entity: block }`), and `matchReferrers` throws when no lookup is supplied instead of answering "no referrers".
- **Imports.** A table is imported from its entity file and an enum from its owner's `.enums` leaf; the two are never
  one statement, and an enum is never imported from an entity file (§2.1).
- **No writes for a child.** The derivation lists no write use case for any child: no create, update or delete use case,
  route or provider. Its repository still inherits `create`. S4 re-enables writes.
- **ADR-046 (phase R).** The existence decision above is derived once: `writesDisabledBy(definition)` in
  `src/derived/api/entity.ts` returns the YAML path that turned the write side off — `['inherits']` for a child,
  `['generate', 'writes']` for the existing opt-out — or `null`. `deriveEntityApiSurface` reads it for the create /
  update / delete use cases and routes and records it as `EntityApiSurface.writesDisabledBy` (a `YamlRef`, absent when
  writes are on); the templates print use cases and routes from `apiSurface`, and `entity-locals.js` reads
  `apiSurface.useCases` for the use-case output paths (there is no `generateWrites` local), so the module providers,
  use-case paths and controller cannot disagree with the surface. S2 adds no method, class name or route of its own — the DDL
  (columns, constraints, enums file) is outside ADR-046's scope (§4: SQL and file paths are not derived). Golden:
  `email`, `meeting`, `communication`, `email_thread`, `meeting_transcript` (the baseline's new entities); the
  `matrix-writes-false` case gains `writesDisabledBy` (the same field, its other cause). Studio's API tab shows both
  as "Writes off", credited to the declaration. S4 deletes the `inherits` branch of `writesDisabledBy`.
- **ADR-046 Phase B (phase R2).** Rebased onto Phase B (#888–#898): one conflict (`package.json`'s published file
  list); the S2 behaviour sat in code Phase B left alone. Render goldens: five matrix entity files re-blessed for
  S2's `(t)` → `(tCols)`. Generated bytes are otherwise unchanged from phase R.
- **Not done, and where it lands.** **Until S3, a child's reads are unscoped** (`tableScope(schema.meetings,
  UNSCOPED)` in the relations manifest, and no scope in its repository), which breaks charter I3 for a
  tenant-scoped family: another tenant's child row is readable at the root. S2 must not land without S3; the stack
  lands atomically. The child also has no edges (S3). **For S6:** the frontend emitter does not read
  `generate.writes`, so a child would get mutations aimed at routes that do not exist until S4/S5. A table with a derived
  `match:` column cannot be created through its generated `create` until S4: the column is NOT NULL, absent from
  the DTO, and filled by the repository's scalar subquery, which is A5's "the matched column is filled by the
  insert" and lands in S4. The column is absent from the output DTO too: decided, not emitted (D2, §11.3). S2's integration test covers A5's two rejections and the derived column's NOT NULL.
- **Gates.** `test/scaffold/tests/inheritance-ddl.test.ts` asserts by SQLSTATE and constraint name, with a
  succeeding control for each rejection. A15, first half: with the kind FK left out of the template, the A4 cases
  (insert under another kind, update of the base kind) and the part-over-another-kind case went red; restored.

**S3 — Relations, scope and reads.**

- Touches: `src/emitters/relations/build-graph.ts` (`:200`, beside `:259-293`), `types.ts` (`ScopeConfigLiteral`
  `:31`, the `inherits` marker on `RelationEdge`), `emit-manifest.ts` (`renderEdge` `:61`, the scope constants);
  `runtime/base-classes/scope-filters.ts` (`ScopeConfig` `:65`, `scopeFilter` `:194-214`); new
  `runtime/base-classes/inheritance.ts` (`flattenBase`, `asKind`, the errors) exported from
  `runtime/base-classes/index.ts`; `repository.ejs.t` and `service.ejs.t` for `findWithBase`, `findManyWithBase`,
  `findAllKinds`, `findKindById`, `listKind`, `countKind`, `findOrphans`.
- Must not touch: `create` / `update` / `delete`, the DTOs, the frontend emitter. A change under
  `runtime/base-classes/` is not validated by `bun run typecheck` alone (charter I9): run the smokes.
- Adds: `.toSQL()` unit tests beside `src/__tests__/runtime/base-classes/read-api-sql.spec.ts`; scope tests in
  `test/scaffold/tests/` modelled on `relation-scope.test.ts`.
- Gates: `just test-unit`, `just test-baseline`, `just test-smoke`, `just test-integration`.
- Closes: A8, A9, and the manifest half of A12.

**S3 as built (2026-11-13).** What the build settled, beyond the plan above:

- **The base scope is a field of `BehaviorConfig` and `ScopeConfig`.** `BaseScope` (`runtime/base-classes/scope-filters.ts`) is
  `{ table, softDelete, userTracking }`: the base table as the schema exports it, and which of the two lifecycle guards the
  base declares. `scopeFilter` appends `exists (select 1 from <base> where <base>.id = <child>.id and <the base's
  soft-delete / user axes>)` as its last conjunct, so the root (`scopeAndOn`, `rootFilter`) and every hop (`hopScope`) get it
  from the one function. The tenant axis is **not** repeated on the base: the child's own tenant column is pinned to the
  base's by a composite FK. A base with neither guard (a tenant-only family) emits no `baseScope` and the SQL has no
  `exists`. The subquery names the base by its real table name; it is the innermost FROM entry there, so it also holds under
  RQBv2's aliased root (`"d0"`), and the unit spec pins the rendered SQL at the root and at a hop. `isUnscoped` /
  `isUnscopedConfig` count a `baseScope`.
- **`softDelete` in `scopeAnd` / `scopeConfigFor` means "apply the lifecycle guards", and only that.** Every read passes
  `softDelete: true`; a by-id write passes nothing and still matches a soft-deleted row. What is applied comes from the
  declaration: the entity's own `soft_delete` (`behaviors.softDelete`) and, for a child, the base's (`baseScope.softDelete`),
  both masked by the flag. So a hand-written `{ softDelete: false }` that wants deleted rows gets them on a child as on a table
  (before this, reads passed `behaviors.softDelete`, which is `false` for a child, and the flag meant two things).
  `user_tracking` applies always, as it does on a table.
- **The child's scope is derived, not declared.** `entityScope(def, tenancyColumn, base?)` takes the base (definition and table
  export) for a child and **throws without it**: a child scoped without its base would read unscoped, an absent input read as
  permissive. Tenancy is `resolveChildTenancy` (the base's column, strict); `softDelete` and `userTracking` on the child's own
  literal are `false`; `baseScope` carries the base's. The manifest renders it as one more key on the child's
  `tableScope(...)` literal. In the generated repository the same derivation arrives as `scopeTenantScoped` /
  `scopeTenantColumn` / `familyChild.baseScope` locals (`entity-locals.js`, from `familyReads` in
  `templates/_shared/inheritance.mjs`); the entity's own `tenantScoped` local is unchanged, because it also drives the
  DDL and the DTOs, which the child's inherited tenant column already has through `inheritedKeyColumns`.
- **`hopCanDropTarget` counts `baseScope`.** A target with a base scope can be dropped by a hop (its base is soft-deleted,
  or another user's), like a target with its own `soft_delete`. That is why a `belongs_to` *into* a soft-delete family's child is `optional` even
  over a NOT NULL FK. It also changes one pre-existing baseline edge, but **not through `baseScope`**:
  `meeting_transcripts.meeting` was `optional: false` with no `where`, and is now `optional: true` with
  `hopScope(t, MEETINGS_SCOPE, …)`. That comes from the existing tenant clause of `hopCanDropTarget` (an unscoped source
  hopping into a target that is now tenant-scoped, because the child's scope is its base's tenant column); it closes the I3
  hole (an unscoped read of a tenant-scoped child). **Behaviour change:** a `meeting_transcripts → meeting` traversal with no
  tenant boundary (a background job) now throws under `strict`, as any hop into a tenant-scoped table does.
- **The two edges.** `RelationEdge.inherits` is `'base'` on the child's `<base name>` edge and `'child'` on the base's
  `<child name>` edge (the entity name, camelCased, **not** the kind value: `transcriptCommunicationPart`, not `meeting`).
  Child to base is `optional: false`, the exception to `hopCanDropTarget` that RFC §3.1 documents and `build-graph.ts`
  states at the `push`. A child whose base is not in the entity set is an **error**, not a warning
  (its scope cannot be derived without the base, and `buildRelationGraph` derives it before it emits the edge).
- **`inheritance.ts`** has `flattenBase`, `Flattened`, `asKind`, `OrphanBaseError`. `Flattened<R, K extends PropertyKey>`, not
  `K extends keyof R` as §6 first sketched: inside the generated generic method (`MeetingFlat<W, C>`), `R` is a deferred
  relational-query result and `K extends keyof R` is TS2344 (measured: the baseline typecheck failed on it). `asKind(row,
  discriminator, childKeyByKind)` drops the other kinds' keys from the row, throws `OrphanBaseError` for a kind in the map whose
  child is `null`, and passes a base-only kind through bare. `OrphanBaseError` carries `id`, `kind` and `childKey`. It is in
  `VENDORED_RUNTIME_FILES` and has a `runtime-mode` import (`inheritanceImport`), like every runtime file a generated
  repository imports.
- **The reads.** `findWithBase` / `findManyWithBase` take `ReadOptions<W, C>` like every other read and return
  `MeetingFlat<W, C>`; the base is joined as `with: { ...opts.with, communication: true }`, so a caller's own
  `communication: {...}` include is overridden by `true`. `findManyWithBase` has `findByIds`' contract. The base repository
  gets `findAllKinds` (`kinds?` filters the scan and joins only those children), `findKindById`, `listKind<K>` (flat; `K` is a
  child kind, returned as `<Base>FlatByKind[K]`), `countKind` (`count` on the same scope) and `findOrphans` (a `NOT EXISTS`
  per child kind, in a module-level `<base>OrphanFilter` with camelCase bindings because it reads the children's table
  exports (the emitted-name hygiene rule, #813), on the base's root scope, ordered by `id`, so a `limit` is a stable subset). All are one statement and every
  root predicate is `{ RAW: this.rootFilter(...) }` (the READ-1 §5.3 gate counts them: 6 → 12). `<Base>OfKind`,
  `<Base>Kind` (= `<Base>['kind']`, so it also holds for a `choices_of:` discriminator), `<Base>FlatByKind` and the
  per-kind join are emitted into the base repository file; the services forward every method. A base with no child table
  (every kind base-only) gets none of it.
- **`includes` follows the family.** `includes` (the entity's repository can name a `with`) is true when the entity declares
  relationships **or** is a child **or** a base with children, decided after `familyReads` in `entity-locals.js`. So a child's
  plain reads type `with: { communication: true }` and the base's `findById` / `findByIds` / `list` type
  `with: { meeting: true, email: true }` (§3.3) by design, including for a fields-only child (`message_communication_part`,
  which failed to compile with `Cannot find name '…Include'` when the family reads imported the type only under `includes`).
  The controller and use cases change type-only; HTTP behaviour is unchanged (`?include=` is still a 400, the allowlist is S5's).
  `test/baseline-type-assertions.ts` asserts the include typing, with a `@ts-expect-error` so it cannot go vacuous.
- **One behaviour derivation in the templates.** `resolvedBehaviorNames(def)` in `entity-locals.js` serves the entity's own
  behaviors and its base's. The relations emitter keeps its own `behaviorNames` on purpose: it uses the throwing
  `requireImpliedBehaviors`, because a manifest that silently dropped an unregistered pattern's behavior would narrow a scope.
- **Gates.** `src/__tests__/runtime/base-classes/inheritance-read-sql.spec.ts` pins the SQL (A9: one statement, `kinds` joins
  one child, `findOrphans`; A8: the `EXISTS` at a child root read and at a hop, none for the tenant-only family, none on a
  by-id write); `src/__tests__/emitters/relations/inherits-graph.test.ts` pins the two edges and the scope literal on the
  §13.1 family (the manifest half of A12); `test/scaffold/tests/inheritance-reads.test.ts` runs the union, the orphan,
  and both scope cases against Postgres through the generated repositories and a hand-written `db.query`;
  `inheritance-scope-http.test.ts` asserts `GET /meetings` and `GET /meetings/:id` are scoped (it needs a tenant boundary,
  which the other HTTP suites lack, so it mounts the generated `MeetingsModule` behind a header-driven one). The cross-checks: the generated reads' statement counts are asserted in `inheritance-reads.test.ts`, against the generated code. A15: with the
  base-scope predicate removed, the soft-delete cases went red; with the child's tenant scope removed (the S2 tree) the HTTP
  cases went red; both restored.
- **The frontend.** `bun test src/__tests__/emitters/frontend` and `just test-smoke-frontend` are green and the frontend graph
  golden is unchanged: the golden's entity set has no `inherits:`, so the new edges do not reach it. S6 owns the
  inner join and the `<child>WithBase` helper; until then `buildRelationGraph` hands the frontend the `inherits` marker and
  the frontend ignores it.
- **ADR-046 (phase R).** The family read surface is derived once in `src/derived/api/`. Kinds: repository `with_base`
  (`findWithBase`, `findManyWithBase`; origin the child's `inherits:`, `readOptions: columns+with`), `all_kinds` / `kind_by_id` / `list_kind` / `count_kind`
  (`findAllKinds`, `findKindById`, `listKind`, `countKind`, one kind each) and `orphans` (`findOrphans`) (origin the base's `discriminator:`,
  its `note` naming the child kinds); the service entries carry the same kinds with `delegatesTo` the repository's. Names are
  `FAMILY_METHOD` in `names.ts`. Existence: `familyReadSurface(definition, children)` — a child always, a base only when it
  has at least one child table (a base with none is a plain entity with an enum). Children come from the whole set
  (`inheritanceChildrenOf` in `src/schema/inheritance.ts`, one owner for the derivation, `familyReads` and the includes gate);
  `deriveEntityApiSurface` takes them as a required `inheritanceChildren` input (`deriveProjectApiSurface` computes them).
  **`includes follows the family` moved with it:** `hasTypedInclude(definition, children)` is the one rule (own non-`through`
  relationships, or a `cardinality: one` role edge, or a child, or a base with children), read by `deriveEntityApiSurface` (`typedInclude` / every read's `readOptions`; `entity-locals.js` reads only `apiSurface.repository.typedInclude`)
  and by the include-allowlist gate in `build-includes.ts`, which replaces `declaresOwnRelation`. That last reader is a real
  change, in two ways: a child or a base with children that declares `api.includes` was refused as "no typed include" while its
  repository typed one, and so was an entity whose only edge is a `cardinality: one` role (the old rule read `relationships:`
  alone; the template's merged-roles rule typed one). Both are accepted now; `build-includes.test.ts` pins each.
  The templates read the methods off `apiSurface` (no flag local); the type names, table exports and import paths stay in `familyReads` (outside ADR-046 §4). Golden: `communication`,
  `email` and `meeting` gain the methods (and `communication`'s `typedInclude` flips to `true`, which the generated code
  already was — the derivation had not seen the family); new matrix case `matrix-discriminator-no-child`. No generated byte changes.
- **ADR-046 Phase B (phase R2).** Rebased onto Phase B (#888–#898) (the 12 slice commits were applied as one 3-way merge onto S2's tip, so each
  conflict was resolved once). The conflicts were `repository.ejs.t`, `service.ejs.t`, `entity-locals.js`, `build-includes.ts` and its test, and
  `src/derived/api/entity.ts`. The two templates now print the family reads inside Phase B's loop over `apiSurface.*.methods`, by `m.kind`
  (`with_base`, `all_kinds` / `kind_by_id` / `list_kind` / `count_kind`, `orphans`; the first read of a group opens its banner, names and parameter names are `m.name` / `m.params`).
  Deleted: the `familyReadsWithBase` / `familyReadsAcrossKinds` flag locals and the `includes` local; the templates' `_child` / `_base` are now
  "has a `with_base` / cross-kind method". `declaresOwnRelation` (Phase B B3) is gone — `hasTypedInclude` is its one replacement, read by
  `deriveEntityApiSurface` (which `entity-locals.js` now gives `inheritanceChildren`) and by the include gate. In the derivation the family
  entries moved to sit right after the core reads (repository after `count`, service after `list`), so the loop prints them where phase R did:
  `email` / `meeting` goldens are a pure reorder. The inherited-methods comment moved to the loop's end so it follows the last read of either
  kind, and the Declarative-queries banner moved to after the run of count + family reads. Render goldens: the new `matrix-discriminator-no-child` case is blessed; every other case is byte-identical. Generated bytes are
  unchanged from phase R. The allowlist did not grow.
  **Follow-up (changes bytes, so not in phase R):** the file-private helpers `repository.ejs.t` emits for a base (`<e>KindJoins`, `<e>OrphanFilter`, `<E>_CHILD_KEY_BY_KIND`) are named per entity by inline template string-building; derive those names in `src/derived/api/names.ts` and print them.

**S4 — Pair writes and the upsert.**

- Touches: `repository.ejs.t` (the three overrides, `upsertByNaturalKey` on base and child, the scalar-subquery
  fill for `match:` columns); `module.ejs.t` (`:62` imports, so a child's module can inject the base repository);
  `service.ejs.t`; `runtime/base-classes/base-service.ts` (`:141-199`: `baseEntityName`, the overridable
  pre-update read, upsert events); `inheritance.ts` (`splitByOwner`, `inTransaction`, `KindMismatchError`,
  `KindImmutableError`, `KindRequiresChildError`); the write use-case templates, re-enabled for children.
- Must not touch: the read surface from S3, `integrated-entity-repository.ts`.
- First task: measure whether the widened `create` / `update` signatures satisfy `IBaseRepository`
  (`base-service.ts:39-56`) under the smoke's consumer tsconfig. If they do not, the fallback is to keep the
  inherited signatures and add the flat-typed methods under their own names, with the inherited ones throwing on a
  child. Record the result in this RFC.
- Adds: `test/scaffold/tests/inheritance-writes.test.ts`.
- Gates: `just test-unit`, `just test-baseline`, `just test-smoke`, `just test-integration`.
- Closes: A6, A7, A11, and the rest of A5 (the insert fills the matched column).

**S5 — DTOs, use cases, controllers.**

- Touches: `templates/entity/new/backend/dto/*.ejs.t`; `use-cases/find-by-id.ejs.t`, `list.ejs.t` (`:97-111`, the
  sort column test must use the base's columns for a child), `create.ejs.t`, `update.ejs.t`; `controller.ejs.t`;
  whatever the OpenAPI emission reads for the flat and union outputs.
- Must not touch: `runtime/`, the relations emitter.
- Adds: cases in `test/scaffold/tests/http.test.ts` for the child's flat routes and the base's restricted create.
- Gates: `just test-baseline`, `just test-smoke`, `just test-integration`.
- Closes: A10, and the rest of A2.

**S6 — Frontend graph, Studio, docs.**

- Touches: `src/emitters/frontend/graph-model.ts` (`:289`), `emit-graph.ts` (the root joins `:522-531`, the new
  helper); the frontend smoke fixtures and `test/smoke/fixtures-frontend/usage/graph-usage.ts`; the golden
  snapshots under `test/frontend-graph-golden/`; `tools/studio/src/inspector/relationship-kinds.ts` and
  `tools/studio/src/graph/edge-kinds.ts` (one row each, colours as `{ light, dark }`); `CLAUDE.md`;
  `consumer-skills/entities/yaml-reference.md` and `SKILL.md`; this RFC's status and any detail the build changed. S6's docs also cover three generator-wide changes S2 made that are not inheritance-specific: the `<entity>.enums.ts` leaf module, the `tCols` callback parameter, and the C5 name-length check; and `.claude/skills/codegen/SKILL.md`'s "every generated FK callback is `.references(…)`" (a `match:` `belongs_to` emits a composite `foreignKey(...)`).
- Must not touch: the backend templates.
- Gates: `just test-smoke-frontend`, `just test-studio`, `just test-all`.
- Closes: A12, A13, A14, A15, A16.

**S7 — `Integrated` on a child. Not in v1.** Described in §4.2. S7 also widens R11 to accept behavior columns in a natural key (§4.2). File it as its own issue when a consumer writes a
family through the generated sink.

### 13.3 Rules for every slice

- Report gate output from the run made after the last edit. No filtered error class, no directory carve-out.
- A new gate goes into `just test-all` or gets a CI job. Check that it can fail on its own subject before calling
  it done.
- No backwards compatibility: no deprecated alias, no old-and-new shape. Baselines regenerate.
- Generated files are complete-file and `@generated`. No inject template.
- When the build finds this RFC wrong, fix the RFC in the same PR.
- Nothing from a host application in code, fixtures, commits, PRs or issue comments.
