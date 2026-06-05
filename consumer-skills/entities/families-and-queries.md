<!-- managed by @pattern-stack/codegen — re-run `codegen skills install` to refresh. Edit the package source, not this vendored copy. -->

# Entity families & declarative queries

## Families (the `pattern:` field)

Every entity declares a `pattern`. The family decides which methods the
generated repository and service inherit on top of the standard CRUD set. The
base classes are vendored into `@shared/base-classes/*` at project init.

**Standard CRUD set (every family):** `findById`, `findByIds`, `list`, `count`,
`exists`, `create`, `update`, `delete`, `upsertMany`. Every write method accepts
an optional `tx?: DrizzleTx` for transactional composition.

| Family | Use it for | Adds on top of CRUD |
|---|---|---|
| `Base` | plain tables with no special access pattern | nothing — standard CRUD only |
| `Synced` | records mirrored from an external system (have an external id + per-user visibility) | `findByExternalId`, `findAllByUserId`, `findVisibleByUserId`, `syncUpsert` |
| `Activity` | time-ordered activity/interaction rows scoped to a subject | `findByDateRange`, `findByUserId`, `findBySubjectId`, `findRecentBySubjectId` (subject FK + recency column resolved from `config: { Activity: { subject: <entity> } }`) |
| `Metadata` | key/value or definition/value rows describing other entities | `findByEntityIdAndType`, `listByEntityId`, `listHistoryByEntityId` |
| `Knowledge` | semantically-searchable knowledge rows (pgvector at runtime) | `semanticSearch`, `findPendingByOpportunityId`, `updateStatus`, `updateStatusBatch` |

Choosing a family:
- Mirrors an external system (CRM, etc.)? → `Synced` (often paired with the
  `sync` skill).
- Append-only timeline tied to a parent record? → `Activity`.
- Describes/annotates other entities (incl. the EAV value table)? → `Metadata`.
- Vector search / RAG? → `Knowledge`.
- None of the above? → `Base`.

App-defined patterns are also supported (a project can register its own family
base); use the project's existing convention if one is present.

## Declarative queries (the `queries:` block)

A `queries:` entry generates a typed repository method, the interface
signature, an injectable query use case, and its module registration — no
hand-written finder.

```yaml
queries:
  - by: [user_id]                 # → findByUserId()
  - by: [email]                   # → findByEmail()  (unique)
    unique: true
  - by: [account_id]              # → findByAccountId(), ordered
    order: created_at desc
  - by: [user_id, account_id]     # → findByUserIdAndAccountId()
```

Shapes:
- **`by: [col, …]`** — equality finder on one or more columns. Method name is
  derived (`findByUserIdAndAccountId`). Multi-column finders AND the conditions.
- **`unique: true`** — returns a single row (or null) instead of an array, and
  marks the underlying index unique.
- **`order: <col> <dir>`** — default ordering for the finder (e.g. `created_at
  desc`).

### Filtered search with pagination

```yaml
queries:
  - name: search                  # → SearchContacts use case + GET /contacts/search
    filters: [user_id, account_id, email]   # optional equality filters
    search: name                  # ilike column for free-text
    paginate: true                # returns { items, total, limit, offset }
```

A `name`d query with `filters`/`search`/`paginate` generates a search use case
and a `GET /<plural>/search` route. `paginate: true` makes the route accept
`limit`/`offset` and return a paged envelope.

## Non-obvious rules

- **Finder names are generated** from the column list — don't also hand-write a
  finder of the same name; compose on top instead.
- **Unique finders return a single nullable result**; non-unique return arrays.
- **`order:` is the default sort**, not a parameter — add a `queries:` search
  entry if you need caller-controlled ordering.
- **Family methods assume their columns exist.** `Synced` expects an external-id
  + user-visibility shape; `Activity`'s subject finders expect the subject FK
  named by its `config:` (`subject: person` → `person_id`, or an explicit
  `subjectColumn`) plus a recency column (`occurred_at` by default, or
  `config.occurredAt`). If your table doesn't fit, pick `Base` and add explicit
  `queries:`.
