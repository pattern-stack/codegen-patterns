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
    type: string           # string | integer | decimal | boolean | uuid | date | datetime | json | enum
    required: true         # NOT NULL + required in Create DTO
    max_length: 255        # string length constraint (DB + Zod)
    index: true            # single-column index
  status:
    type: enum
    choices: [active, inactive, archived]   # enum members
  metadata:
    type: json             # jsonb column
  score:
    type: decimal
    nullable: true
```

Type notes:
- `uuid` — typically the PK and foreign keys.
- `enum` — requires `choices:`; generates a TS union + DB check/enum.
- `json` — `jsonb`; typed as `Record<string, unknown>` unless you narrow it in
  your own code.
- `datetime` vs `date` — timestamp vs date-only column.

## `behaviors:` — cross-cutting columns + logic

```yaml
behaviors:
  - timestamps             # createdAt, updatedAt (auto-managed)
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
- `has_many` / `has_one` are the inverse side (no column here; drives the typed
  relation accessor + Drizzle `relations()`).
- Cross-entity targets must resolve at generation time — regenerate the set with
  `codegen entity new --all`.

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
