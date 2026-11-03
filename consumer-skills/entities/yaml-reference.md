<!-- managed by @pattern-stack/codegen — re-run `codegen skills install` to refresh. Edit the package source, not this vendored copy. -->

# Entity YAML reference

Every block of an `entities/<name>.yaml` file and what it generates.

## `entity:` — identity

```yaml
entity:
  name: contact            # REQUIRED. singular snake_case. Drives class names + table.
  plural: contacts         # optional; inferred (pluralized) if omitted
  table: contacts          # optional; defaults to the plural
  pattern: Synced          # the family — Base | Synced | Activity | Metadata | Knowledge
                           #   (or an app-defined pattern). See families-and-queries.md.
```

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

A `belongs_to`'s FK column follows the same rule from its `fields:` entry; a
`nullable:` on the relationship itself outranks it.

Uniqueness — a field's `unique: true` emits `uniqueIndex('<table>_<col>_uniq')`
(#511). Under `tenant_scoped: true` it is per tenant: `(tenant_id, <col>)`, named
`<table>_tenant_id_<col>_uniq`, and no bare global unique is emitted. A
`belongs_to` FK column declared in `fields:` with `unique: true` is a one-to-one.
On a non-tenant entity, `unique: true` + `index: true` on one field emits only the
unique index (it already leads with the column); under `tenant_scoped` both are
kept, since `(tenant_id, <col>)` cannot serve a lookup on `<col>` alone. On a non-tenant
entity NULLs are distinct (Postgres default), so a nullable unique column admits many
NULLs. On a `tenant_scoped` entity the unique is NULLS NOT DISTINCT (#784, see
`unique_indexes:` below), so a nullable `unique: true` column admits one NULL per
tenant; for "unique when present", declare it as
`unique_indexes: [{ fields: [<col>], nulls_not_distinct: false }]` instead of the flag.
The index is not partial: on a `soft_delete` entity a soft-deleted row still occupies it;
for "soft-deleted rows do not count" use a single-field `unique_indexes:` entry with
`where: "deleted_at IS NULL"` (#784) instead of the flag. A
`queries:` entry's `unique: true` is a finder hint (one row or null) and emits no
DDL; declare the constraint with field `unique: true` or `unique_indexes:`.

Type notes:
- `uuid` — typically the PK and foreign keys.
- `enum` — requires `choices:`; generates a TS union + DB check/enum.
- `json` — `jsonb`; typed as `Record<string, unknown>` unless you narrow it in
  your own code.
- `datetime` vs `date` — timestamp vs date-only column. `datetime` is `timestamp with time zone`
  (#796), as are the `timestamps` / `soft_delete` columns and a junction or relationship's time
  columns. `timezone: false` (datetime only) keeps a wall-clock `timestamp without time zone`
  column, read through the `Date`'s UTC fields. With Electric sync, a `timezone: false` column
  arrives as a string unless `frontend.parsers.timestamp` is set.
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

## `relationships:` — foreign keys + typed accessors

```yaml
relationships:
  account:
    type: belongs_to       # belongs_to | has_many | has_one
    target: account        # the referenced entity (must have its own YAML)
    foreign_key: account_id
```

- `belongs_to` adds the FK column on this entity.
- `has_many` / `has_one` are the inverse side (no column here; drives the
  service-layer composition method on the declaring entity's service).
- Cross-entity targets must resolve at generation time — regenerate the set with
  `codegen entity new --all`.
- The target's table and folder come from the target's own YAML (`plural:`,
  `context:`), never from pluralizing its name. A `belongs_to` (or field
  `foreign_key:`) whose target has no YAML in the entities directory is a
  generation error; a `has_many` onto one is simply not wired.

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
where `tenant_id` is prefixed onto the columns):

| Entry | not tenant-scoped | tenant-scoped |
|---|---|---|
| `{ fields }` | `uniqueIndex(n).on(cols)` | `unique(n).on(tenant_id, cols).nullsNotDistinct()` |
| `{ fields, nulls_not_distinct: true }` | `unique(n).on(cols).nullsNotDistinct()` | same as above |
| `{ fields, nulls_not_distinct: false }` | `uniqueIndex(n).on(cols)` | `uniqueIndex(n).on(tenant_id, cols)` |
| `{ fields, where, name }` | `uniqueIndex(n).on(cols).where(sql...)` | `uniqueIndex(n).on(tenant_id, cols).where(sql...)` |

- `name:` defaults to `<table>_<cols>_uniq` (with `tenant_id` first under tenancy). It is a lowercase snake_case
  identifier of at most 63 characters, and required with `where:`. Index names are schema-wide in Postgres, so prefix
  them with the table name.
- `where:` is raw SQL over snake_case column names of this table. Those names are rewritten to Drizzle column
  references, so drizzle-kit quotes them. It is one expression: `;`, `--`, `/*`, `$`, backtick, backslash and
  unterminated quotes are errors outside quoted text. Words after `.` or `::`, before `(`, `.` or `'`, and
  anything in quotes are never rewritten. A word spelled like a column but used as a type is rewritten, so write
  `x::date`, not `CAST(x AS date)`, on a table with a `date` column. Other words are not checked, so a stale column
  name fails at `drizzle-kit push`, not at generation.
- `where` and `nulls_not_distinct: true` are mutually exclusive: drizzle-orm 1.0.0-rc.4 has no NULLS option on a
  partial index. So a partial entry on a tenant-scoped entity does not deduplicate rows whose `tenant_id` is NULL.
- On a tenant-scoped entity the default is NULLS NOT DISTINCT, so the NULL-tenant partition (ADR-042 §3) is one
  partition. NULLS NOT DISTINCT covers every column of the constraint, so a nullable column in it admits one NULL per
  key. NULLS NOT DISTINCT needs PostgreSQL 15+.
- Generation errors: a `fields:` name that is not a column of the table, `tenant_id` listed on a tenant-scoped
  entity, a field repeated within an entry, two constraints with one name, and two non-partial uniques over the
  same columns (including a field `unique: true` repeated here).

## `generate:` — output toggles

```yaml
generate:
  writes: true             # default true — emit POST/PATCH/DELETE + create/update/delete use cases
```

Set `writes: false` for a read-only resource (only GET routes + read use cases).

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
