<!-- managed by @pattern-stack/codegen — re-run `codegen skills install` to refresh. Edit the package source, not this vendored copy. -->

# Entity YAML reference

Every block of an `entities/<name>.yaml` file and what it generates.

## `entity:` — identity

```yaml
entity:
  name: contact            # REQUIRED. singular snake_case. Drives class names.
  plural: contacts         # REQUIRED. snake_case; the Drizzle table export, db.query key, module folder
  table: crm_contacts      # optional. the literal SQL table name, used verbatim (no prefix)
  table_prefix: crm__      # optional. overrides codegen.config.yaml `tables.prefix`; '' opts out.
                           #   Exclusive with table.
  pattern: Synced          # the family — Base | Synced | Activity | Metadata | Knowledge
                           #   (or an app-defined pattern). See families-and-queries.md.
```

**The SQL table name** (TABLE-0) is `table:` if set, else `<table_prefix ?? tables.prefix><plural>`. With neither
key and no project prefix it is `plural`. Only SQL-facing names follow it: `pgTable('…')`, index / constraint names
(`<table>_…`), the Electric shape's `table`, and a field's `foreign_key: <table>.<column>`, which names the **SQL** table.
The export, `db.query` key, folder, classes and REST route stay on `plural`. `table:` equal to `plural` is the same as leaving it out. Two definitions
(entities or junctions) resolving to one SQL table is a generation error. Junction YAMLs take the same
`table:` / `table_prefix:`.

**Reserved names.** `promise`, `array` and `date` are rejected (also as relationship names): the generated type
would shadow the `Promise`, `Array` or `Date` global, which generated code uses in nearly every signature. No other
name shadows a TS global: `record`, `item`, `map` and `error` work, and no plural collides with a generated local
(`items`, `options`, `conditions`). A name equal to a symbol the templates import (`page`, `post`, `patch`, `query`,
`body`, `param`) still gives a duplicate-identifier error (#833). (#813)

## `tenant_scoped:` — the tenant column

```yaml
tenant_scoped: true                        # scope on the project's tenant column (tenant_id by default)
tenant_scoped: { column: organization_id } # scope on this column instead
```

`tenant_scoped` scopes the entity's repository on one column. Which column is decided in one place
(`src/schema/tenancy.ts`): the entity's `tenant_scoped: { column }`, else the project's `tenancy.column` in
`codegen.config.yaml`, else `tenant_id`. The name is snake_case.

- **Adoption.** If the entity already declares that column, as a `fields:` entry or as the foreign key of a
  `belongs_to`, codegen uses it instead of emitting a second one. It keeps the declaration's own type and
  nullability (`required: true` makes a field NOT NULL; a `belongs_to` FK is NOT NULL unless it says
  `nullable: true`); a `belongs_to` keeps its `.references()`. A `fields:` entry
  must be `type: uuid`: the ambient tenant is a uuid, so a string column is a generation error naming the entity.
- **Otherwise** the tenant block emits a nullable `uuid` column with that name and no foreign key.
- Either way the column gets one `<table>_<column>_idx` index (an adopted column's own `index: true` folds into it),
  is the prefix of every `unique: true` / `unique_indexes:` constraint, is left off the create/update DTOs and the
  integration write surface (the repository stamps it), and is the column the hop scope in the relations manifest
  filters on.
- **Collisions are refused.** The column may not be `id`, nor a column the entity's behaviors emit (`created_at`,
  `updated_at`, `deleted_at`, `created_by`, `updated_by`, `provider`, `external_id`, `provider_metadata`, including
  the ones `pattern: Integrated` implies). The error names the entity, the column and what owns it.
- **Not listed in `fields:` of a unique entry.** The tenant column is prefixed automatically; listing it is an error.
- A NOT NULL adopted column (a `required: true` field, or a `belongs_to` FK without `nullable: true`) leaves the
  NULL-tenant partition: a request with no tenant writes NULL into it
  and Postgres rejects the insert.
- `tenant_scoped` is not supported with `eav_value_table: true`.

## `fields:` — columns

Each key is a `snake_case` column; the generated TS property is `camelCase`.

```yaml
fields:
  email:
    type: string           # string | integer | decimal | boolean | uuid | date | datetime | json | enum | string_array
    required: true         # NOT NULL + required in Create DTO
    max_length: 255        # string length constraint (DB + Zod)
    index: true            # single-column index
    unique: true           # unique index; per tenant under tenant_scoped
  status:
    type: enum
    choices: [active, inactive, archived]   # enum members
  metadata:
    type: json             # jsonb column
  score:
    type: decimal
    nullable: true
  pts:
    type: integer
    nullable: false        # NOT NULL, optional on create: the DB fills the default
    default: 0
```

Nullability — `required` is the create contract, `nullable` the column:

| Declaration | Column | Create DTO | Read type |
|---|---|---|---|
| `required: true` | NOT NULL | required | `T` |
| `nullable: false` + `default:` | NOT NULL, DB default | optional | `T` |
| `nullable: true`, or neither declared | NULL | optional, accepts `null` | `T \| null` |
| `nullable: false` without `default:` | — | generation error: say `required: true` | — |
| `required: true` + `nullable: true` | — | generation error | — |

A `belongs_to`'s FK column is the exception: it is **NOT NULL unless it says
`nullable: true`**, on the relationship (or role) or on its `fields:` entry, and
the relationship's `nullable:` outranks the field's. `required:` does not decide
it; `required: false` on an FK field without `nullable:` is a generation error.
See `relationships:` below.

Uniqueness — a field's `unique: true` emits `uniqueIndex('<table>_<col>_uniq')`
(#511). Under `tenant_scoped: true` it is per tenant: the constraint
`unique('<table>_<tenant column>_<col>_uniq').on(<tenant column>, <col>).nullsNotDistinct()` (#784; the tenant column
is `tenant_id` unless `tenant_scoped:` names another, see below), and no bare global unique is
emitted. `unique: true` on the tenant column itself means one row per tenant: `unique('<table>_<tenant column>_uniq')
.on(<tenant column>).nullsNotDistinct()`. A
`belongs_to` FK column declared in `fields:` with `unique: true` is a one-to-one.
On a non-tenant entity, `unique: true` + `index: true` on one field emits only the
unique index (it already leads with the column); under `tenant_scoped` both are
kept, since `(<tenant column>, <col>)` cannot serve a lookup on `<col>` alone. On a non-tenant
entity NULLs are distinct (Postgres default), so a nullable unique column admits many
NULLs. On a `tenant_scoped` entity the unique is NULLS NOT DISTINCT (#784, see
`unique_indexes:` below), so a nullable `unique: true` column admits one NULL per
tenant; for "unique when present", declare it as
`unique_indexes: [{ fields: [<col>], nulls_not_distinct: false }]` instead of the flag.
The unique is not partial: on a `soft_delete` entity a soft-deleted row still occupies it;
for "soft-deleted rows do not count" use a single-field `unique_indexes:` entry with
`where: "deleted_at IS NULL"` (#784) instead of the flag. A
`queries:` entry's `unique: true` is a finder hint (one row or null) and emits no
DDL; declare the constraint with field `unique: true` or `unique_indexes:`.

Type notes:
- `uuid` — typically the PK and foreign keys.
- `enum` — requires `choices:`; generates a TS union + DB check/enum.
- `json` — `jsonb`; typed `unknown` on the row and the DTOs (`z.unknown()`) unless you
  narrow it in your own code. On `<Entity>OutputDto` the key is required, as on the row:
  the type is `Required<z.infer<…>>`, because Zod 3 infers a `z.unknown()` key as optional.
  A schema you derive yourself (`<Entity>OutputSchema.pick(…)`) still infers it optional,
  so wrap that in `Required<…>` too.
- `datetime` vs `date` — timestamp vs date-only column. `datetime` is `timestamp with time zone`
  (#796), as are the `timestamps` / `soft_delete` columns (unless switched off — see `behaviors:`
  below) and the time columns a junction or relationship emits itself (which follow the project's
  `behaviors.timezone`). `timezone: false` (datetime only) keeps a wall-clock `timestamp without time zone`
  column, read through the `Date`'s UTC fields. With Electric sync, a `timezone: false` column
  arrives as a string unless `frontend.parsers.timestamp` is set, for example
  `(s) => new Date(s.replace(' ', 'T') + 'Z')`. Upgrading with `drizzle-kit push`: set the database's default
  TimeZone to UTC first, or generate a migration instead. Casts such as `::date` and `date_trunc` on a
  timestamptz follow the session TimeZone; pin it.
- `string_array` — a Postgres `text[]` column; `string[]` on the entity, `z.array(z.string())` in the DTOs.
  Add `choices:` to constrain the elements: the column becomes an array of a generated enum
  (`('pg' | 'sg')[]`), not a single enum value. `default: [pg]` gives the column an array default.

## `behaviors:` — cross-cutting columns + logic

```yaml
behaviors:
  - timestamps             # createdAt, updatedAt (auto-managed; timestamptz)
  - soft_delete            # deletedAt; queries auto-filter deleted rows; GET :id 404s on deleted
  - user_tracking          # createdBy, updatedBy
```

Behaviors compose — list any subset.

**Behavior columns over a host's naive timestamps.** `timestamps` and `soft_delete` emit
`timestamp with time zone`. When you adopt tables whose `created_at` / `updated_at` / `deleted_at`
are `timestamp without time zone` holding UTC, switch them off — for the whole project in
`codegen.config.yaml`, or per behavior on one entity (the entity wins):

```yaml
# codegen.config.yaml
behaviors:
  timezone: false          # default true

# entity YAML
behaviors:
  - name: timestamps
    options: { timezone: false }   # created_at / updated_at without time zone
  - name: soft_delete
    options: { timezone: true }    # override a project-level false
```

Why it matters: Drizzle parses a column by its *declared* type. Declared timestamptz, a naive
column's offset-less text is read in the **process** time zone (a 4-hour skew measured in
America/New_York); declared naive, it is read as UTC. With the knob off, values written through
the generated repositories are stored as UTC wall time — every write path (create, update, soft
delete, integration upserts) stamps the timestamp itself as a JS `Date`. A database-side
`DEFAULT now()` (a raw `INSERT` that omits the column) is stored in the **session** TimeZone, so
keep sessions at UTC. With Electric sync, a switched-off behavior column is a `timestamp` column
like a `timezone: false` field, so it arrives as a string unless `frontend.parsers.timestamp` is set
(see `datetime` above). `timezone` is accepted only on `timestamps` and
`soft_delete`, and only as `true` / `false`.

The project setting means "this host's generated timestamps are naive UTC", so it also covers every
time column a junction or relationship table emits on its own: `created_at` / `updated_at`, and a
junction's `started_at` / `ended_at` / `matched_at`. Those tables have no `behaviors:` list, so the
project value decides; there is no per-junction knob. A `datetime` field you declare keeps its own
`timezone:`.

## `relationships:` — foreign keys + typed accessors

```yaml
relationships:
  account:
    type: belongs_to       # belongs_to | has_many | has_one
    target: account        # the referenced entity (must have its own YAML)
    foreign_key: account_id
```

- `belongs_to` adds the FK column on this entity. **It is NOT NULL unless it says
  otherwise** (Rails 5's `belongs_to`): `nullable: true` on the relationship (or
  `cardinality: one` role), or on the FK's own `fields:` entry, makes it optional;
  the relationship's `nullable:` outranks the field's. A NOT NULL FK is a required
  key on the create DTO; a nullable one is optional and accepts `null`.
  `required:` on the FK field does not decide it, and a written `required: false`
  without `nullable:` is a generation error pointing at `nullable: true` (it used
  to mean nullable). `on_delete: set_null` needs `nullable: true`, and so does a
  self-reference whose root has no parent:

  ```yaml
  relationships:
    parent_account: { type: belongs_to, target: account, foreign_key: parent_account_id, nullable: true }
  ```
- The include's type (`with: { account: true }`) is `optional` (`T | null`) when the
  FK is nullable, **or** when the hop can filter the target out: the target
  soft-deletes or is user-tracked (a deleted or another user's row reads `null`),
  or the target is tenant-scoped and this entity is not (an unscoped row can point
  into another tenant). When both sides are tenant-scoped, the tenant alone does
  not widen it, because a NOT NULL FK onto another tenant's row is a data error.
- `has_many` / `has_one` are the inverse side (no column here; drives the
  service-layer composition method on the declaring entity's service).
- Cross-entity targets must resolve at generation time — regenerate the set with
  `codegen entity new --all`. One run is enough: every `has_many` onto an entity
  in the run is wired. A single-file `entity new <parent>.yaml` wires a
  `has_many` only when its target has already been generated.
- The target's table export and folder come from the target's own YAML (`plural:`,
  `context:`), never from pluralizing its name. A `belongs_to` (or field
  `foreign_key:`) whose target has no YAML in the entities directory is a
  generation error; a `has_many` onto one is simply not wired.

## `api:` — HTTP surface + include allowlist

```yaml
api: false            # no HTTP data plane (no controller routes) for this entity
```

or an object that opens `?include=` on chosen read routes:

```yaml
api:
  includes:
    find_by_id:                 # a generated read route: find_by_id, list, or a queries: finder by method name (findByEmail)
      max_depth: 2              # explicit cap on hops
      paths: [fantasy_teams, fantasy_teams.home_league]
```

- **Closed by default.** No `api.includes` entry for a route means any `?include=` on it is a 400.
- A path is a dot path of relationships. Each segment may be the YAML relationship name
  (`fantasy_teams`) or the relation key (`fantasyTeams`), or any spelling whose camelCase is the key; all name the same edge. `a.b` implies `a`.
- **Clients send relation keys**, which are also the response property names: `?include=fantasyTeams.homeLeague`.
  The YAML spelling is rejected on the wire.
- Generation errors: a path deeper than `max_depth`; a segment that names no relation (the message lists the relation
  keys at that hop and suggests the closest one); a route key that is not a generated read route; a path through an entity declaring `api: false`; `api.includes`
  together with `api: false`; an entity that declares no relationship of its own.

## `unique_indexes:` — unique constraints

```yaml
unique_indexes:
  - fields: [customer_id]                   # 1+ fields
    where: "closed_at IS NULL"              # partial unique index; needs name:
    name: invoices_one_open_per_customer_uniq
  - fields: [customer_id, source_event_id]
    nulls_not_distinct: true                # UNIQUE NULLS NOT DISTINCT constraint
  - fields: [external_code]
    nulls_not_distinct: false               # plain unique index (the opt-out on a tenant-scoped entity)
```

An entry has four shapes (the first column is on a non-tenant entity, the second on `tenant_scoped: true`,
where the tenant column is prefixed onto the columns):

| Entry | not tenant-scoped | tenant-scoped |
|---|---|---|
| `{ fields }` | `uniqueIndex(n).on(cols)` | `unique(n).on(tenant, cols).nullsNotDistinct()` |
| `{ fields, nulls_not_distinct: true }` | `unique(n).on(cols).nullsNotDistinct()` | same as above |
| `{ fields, nulls_not_distinct: false }` | `uniqueIndex(n).on(cols)` | `uniqueIndex(n).on(tenant, cols)` |
| `{ fields, where, name }` | `uniqueIndex(n).on(cols).where(sql...)` | `uniqueIndex(n).on(tenant, cols).where(sql...)` |

- `name:` defaults to `<table>_<cols>_uniq` (with the tenant column first under tenancy). It is a lowercase snake_case
  identifier of at most 63 characters, and required with `where:`. Index names are schema-wide in Postgres, so prefix
  them with the table name.
- `where:` is raw SQL over snake_case column names of this table. Those names are rewritten to Drizzle column
  references, so drizzle-kit quotes them. It is one expression: `;`, `--`, `/*`, `$`, backtick, backslash and
  unterminated quotes are errors outside quoted text. Words after `.` or `::`, before `(`, `.` or `'`, and
  anything in quotes are never rewritten. A word spelled like a column but used as a type or keyword is rewritten, so write
  `x::date`, not `CAST(x AS date)`, on a table with a `date` column. On a table with a `time` column,
  `AT TIME ZONE` renders as `AT ${t.time} ZONE`; likewise `year` in `EXTRACT(YEAR FROM ...)`, and `precision` after
  `::double`. Escape a quote inside a string as `''`, not `E'\''`. Words are ASCII-only (`[A-Za-z_][A-Za-z0-9_]*`);
  a non-ASCII letter next to a column name splits the word. Other words are not checked, so a stale column
  name fails at `drizzle-kit push`, not at generation.
- `where` and `nulls_not_distinct: true` are mutually exclusive: drizzle-orm 1.0.0-rc.4 has no NULLS option on a
  partial index. So a partial entry on a tenant-scoped entity does not deduplicate rows whose tenant column is NULL.
- On a tenant-scoped entity the default is NULLS NOT DISTINCT, so the NULL-tenant partition (ADR-042 §3) is one
  partition. NULLS NOT DISTINCT covers every column of the constraint, so a nullable column in it admits one NULL per
  key. NULLS NOT DISTINCT needs PostgreSQL 15+.
- Generation errors: a `fields:` name that is not a column of the table, the tenant column listed on a tenant-scoped
  entity, a field repeated within an entry, two constraints with one name, and two non-partial uniques over the
  same columns (including a field `unique: true` repeated here).

## `generate:` — output toggles

```yaml
generate:
  writes: true             # default true — emit POST/PATCH/DELETE + create/update/delete use cases
```

Set `writes: false` for a read-only resource (only GET routes + read use cases).

## Junctions — `junctions/*.yaml`

A junction is a first-class many-to-many link table, generated by `codegen junction new`.
Its key is composite (the two FKs, plus `role` when `role` is an enum); there is no `id`.

```yaml
pattern: Junction
between: [opportunity, contact]   # table opportunity_contacts, FKs opportunity_id + contact_id
temporal: true      # default true — started_at, ended_at
sourced: true       # default true — sourced_from, confidence, matched_at
is_primary: true    # default true — is_primary + setPrimary / <plural>SetPrimary
timestamps: true    # default true — created_at, updated_at (stamped on write)
expose_on_parent: { left: true, right: true }   # parent-service fan-out per side
fields:
  role:                           # with choices: the identity enum, NOT NULL, in the key
    type: enum
    choices: [champion, decision_maker, influencer]
  source: { type: string, required: true }        # NOT NULL
  weight: { type: integer, nullable: false, default: 0 }
  meeting_id: { type: uuid, foreign_key: meetings.id, index: true }
```

`fields:` entries are **entity fields**: the same schema, so `required`, `nullable`, `default`,
`foreign_key`, `index`, `timezone` and `choices` mean what they mean in `fields:` above, and an
unknown key is an error (it's `choices:`, not `values:`). Keys that nothing on a junction reads are
refused rather than ignored: `choices_from`, `type: entity_ref`, `unique` (a row is unique by its
composite key), `min` / `max` / `min_length` / `max_length` (a junction has no DTOs) and the
analytics tags (`role` / `agg` / `aggs` / `additivity` / `time`). A field can't be named `id` or
after an endpoint column (`opportunity_id`). A `role` **without** `choices:` is an ordinary
column of its declared type. With `choices:` it's the identity enum and can't be `nullable: true`.

Payload fields are part of the service's `<Junction>LinkInput`, so `attach` (and the parents'
`attach<X>` / `addTo<X>`) can write them. A `required: true` field is a required key, and the
`link` argument becomes required too.

To adopt an existing link table that lacks some base columns, turn them off: `temporal: false`,
`sourced: false`, `is_primary: false`, `timestamps: false`. With `timestamps: false` you may
declare `created_at` / `updated_at` yourself as fields (for example, when the table has only one of them).

## EAV (custom fields)

Two independent flags:

```yaml
# On a normal entity (e.g. opportunity): opt into custom fields
eav: true
```

When `eav: true`:
- Service gains **paired reads**: `findById` (typed entity) and
  `findByIdWithFields` (entity + merged `fields` bag); same for `list`.
- `Create*` / `Update*` use cases accept `{ ...core, fields?: Record<string,
  unknown> }` and run a transactional dual-write.
- Controller adds `GET /:id/with-fields`, `GET /with-fields`, and accepts the
  `fields` bag on POST/PATCH.

```yaml
# On the value-table entity itself (e.g. field_value): mark it AS the EAV store
eav_value_table: true
eav_definition_table: field_definition   # where keys → definition ids resolve
```

When `eav_value_table: true`:
- Repository gets `upsertCurrentValues(rows, tx)` (composite conflict target).
- Service gets `upsertFieldsTransactional(...)` and `findMergedByEntity(...)`
  with internal definition-id resolution.
- The module auto-imports the definition-table module so DI resolves without
  consumer wiring.

The EAV dual-write is coordinated by the **use case** inside `db.transaction` —
services stay single-domain (see the layer rules in the `entities` L0 skill).

## `queries:` — declarative finders

See `families-and-queries.md` for the full `queries:` block (column finders,
unique, ordered, filtered+paginated search).

## Analytics field tags + `analytics:` — the semantic model

Optional. Tag the fields the semantic layer aggregates and groups by; declare
composite metrics in the entity-level `analytics:` block. Nothing is emitted
unless `generate.semantic: true` in `codegen.config.yaml`.

### Field tags

```yaml
fields:
  amount:
    type: decimal
    role: measure              # measure | dimension
    aggs: [sum, avg, min, max] # allowed aggregations → measures amount.sum, amount.avg, …
    additivity: additive       # REQUIRED on a measure — additive | semi | non

  win_probability:
    type: decimal
    role: measure
    agg: avg                   # a single aggregation → the measure is keyed `win_probability`
    additivity: non

  stage:
    type: enum
    choices: [prospecting, negotiation, closed_won]
    role: dimension            # declared value domain is derived from choices

  closed_at:
    type: datetime
    role: dimension
    time: true                 # the time axis; date / datetime only
```

- **`role`** — `measure` is something you aggregate, `dimension` something you
  group or filter by. The field **is** the measure; aggregation is config on it.
- **`agg` / `aggs`** — one of `count`, `count_distinct`, `sum`, `avg`, `min`,
  `max`. Mutually exclusive, and they key the measure differently: `aggs:`
  produces one measure per entry named `<field>.<agg>`, a single `agg:` produces
  one named `<field>`. That name is what a metric leg references.
- **`additivity`** — required on every measure, because it cannot be inferred
  from the type. `additive` = summable everywhere; `semi` = summable except
  across the time axis (a balance); `non` = never summable (a rate, a
  percentage, an average).
- **`time`** — marks the axis a semi-additive measure may not be summed across.
  Only `date` / `datetime` fields, and never on a measure. Grains (day, month,
  quarter) are chosen at query time, not declared.

The field's semantic type, physical column and whether its value domain is
declared are all derived from what the YAML already says — do not restate them.

### `analytics:` — composite metrics

Three kinds, all naming measures by the keys above. A "simple" metric is not a
kind: it is a measure-tagged field.

```yaml
analytics:
  metrics:
    win_rate:                          # numerator / denominator
      type: ratio
      numerator: won_amount.sum
      denominator: amount.sum
      label: Win rate

    gross_profit:                      # arithmetic over measure legs
      type: derived
      expr:
        op: '-'                        # + - * /
        left:  { ref: revenue.sum }    # { ref } names a measure
        right: { ref: cost.sum }       # { lit: 0.5 } is a numeric weight

    running_pipeline:                  # running total
      type: cumulative
      measure: amount.sum
      order_by: created_at             # a field on the measure's own entity
      partition_by: account_id         # optional — the total restarts per partition
```

The block is an **authoring home, not a scope**: the catalog is one flat
namespace across the whole domain, so a metric may name legs that live on
another entity. In exchange, measure keys and metric names must be unique across
every entity — `codegen entity new` and `codegen entity validate` both refuse a
duplicate or an unresolvable leg.

### What gets emitted

With `generate.semantic: true`, `codegen entity new` writes
`<paths.generated>/semantic/`:

- `model.ts` — `buildAggregateModel()`, returning the registry (tables, keys,
  columns, relationships, searchable columns), the per-field analytics tags, the
  Drizzle table + column references, and the composite catalog.
- `index.ts` — the barrel; it also re-exports the model's types.

Both files import their types from `@pattern-stack/query-surface`, so a project
with `generate.semantic: true` installs it (an optional peer of
`@pattern-stack/codegen`, `^0.3.1`). Without it the generated tree fails to
compile with `Cannot find module '@pattern-stack/query-surface'`.

Everything in it is **declared** from your YAML. Two consequences worth knowing:

- **Atomic measures are derived, not written out.** `buildAggregateModel()`
  builds its catalog by calling the semantic layer's own `measuresFromRegistry`
  over the `role: measure` tags and adding your `ratio` / `derived` /
  `cumulative` entries over it. So a query can name either kind —
  `{ ref: 'amount.sum' }` or `{ ref: 'win_rate' }` — and the key rule has one
  owner, the package.
- **Registry keys are your entity names** (singular snake), junctions are keyed
  by `<a>_<b>`, and relationship keys are your YAML relationship names verbatim.
  Those are the names a query uses.
