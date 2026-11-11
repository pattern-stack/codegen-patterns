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
| `Integrated` | records mirrored from an external system (have an external id + provider) | `findByExternalId`, `findManyByExternalIds`, `integrationUpsert` |
| `Activity` | time-ordered activity/interaction rows scoped to a subject | `findByDateRange`, `findByUserId`, `findBySubjectId`, `findRecentBySubjectId` (subject FK + recency column resolved from `config: { Activity: { subject: <entity> } }`) |
| `Metadata` | key/value or definition/value rows describing other entities | `findByEntityIdAndType`, `listByEntityId`, `listHistoryByEntityId` |
| `Knowledge` | semantically-searchable knowledge rows (pgvector at runtime) | `semanticSearch`, `findPendingByOpportunityId`, `updateStatus`, `updateStatusBatch` |

Choosing a family:
- Mirrors an external system (CRM, etc.)? → `Integrated` (often paired with the
  `integration` skill).
- Append-only timeline tied to a parent record? → `Activity`.
- Describes/annotates other entities (incl. the EAV value table)? → `Metadata`.
- Vector search / RAG? → `Knowledge`.
- None of the above? → `Base`.

App-defined patterns are also supported (a project can register its own family
base); use the project's existing convention if one is present.

## Reading: one options shape on every read (READ-1)

Every generated read — `findById`, `findByIds`, `list`, and each plain `queries:` /
`belongs_to` finder — takes the same options, and the result type is inferred
exactly at the call site:

```ts
// a root column mask and a typed include tree, each hop with its own mask
const page = await observations.findByIds(ids, {
  columns: { id: true, type: true, occurredAt: true },
  with: { account: { columns: { name: true } } },
});
// page: Array<{ id: string; type: …; occurredAt: Date; account: { name: string } }>

await accounts.list({
  where: (t) => eq(t.status, 'active'),     // a ROW FILTER — a function of the table
  sort: [{ column: 'name', direction: 'asc' }],
  limit: 50,
  columns: { id: true, name: true },
});
```

- **`where` is a function of the table, never a pre-built `SQL`.** Reads run on the
  relational query builder, which aliases the table (`"accounts" as "d0"`); a
  predicate built from the imported table names a table that is not in scope and
  Postgres rejects it. `count(where)` takes the same function, so a page and its
  total describe one set. There is no `orderBy`: use `sort`.
- **`findByIds`**: `[]` issues no query; duplicates are read once (a uuid in any
  spelling — uppercase, braced — matches its row); rows come back in the **input
  order**; a missing, soft-deleted or out-of-scope id is simply absent.
  One `in (…)` — chunk yourself past ~65k ids.
- **`columns`** is an inclusion (`{ a: true }`) or exclusion (`{ a: false }`) mask;
  an empty mask is a compile error. Omit it for the whole row. (An empty mask on an
  INCLUDE — `with: { x: { columns: {} } }` — is only caught at runtime.)
- **Root and every hop are scoped** (tenant, soft-delete, user) on every method.
- Hoist a mask or include into a `const` **without** a type annotation (or with
  `as const`) — annotating it with `<Entity>Columns` / `<Entity>Include` widens it.

**Reading outside a repository.** A hand-written `db.query.<table>` read gets every
HOP scoped by the generated relations manifest, but its ROOT is scoped by nobody.
Go through the generated repository; if you can't (a cross-entity loader), AND the
exported root scope into the root `where`:

```ts
import { rootScope } from '@generated/relations';

await db.query.accounts.findMany({
  where: { AND: [{ id: { in: ids } }, rootScope.accounts('AccountLoader')] },
});
```

`rootScope.<table>` is typed to its table: another table's scope is a compile error.

**Upgrading a vendored project (`runtime: vendored`)**: run `codegen project update` before
regenerating, so `@shared/base-classes` has the helpers the regenerated repositories call. The
`DRIZZLE` client must be built with the generated `relations` (`drizzle({ client, relations })`);
a repository constructed over a client without them throws, naming the cause.

`activeParentFilter(parentTable, 'fkKey')` returns a row filter too — pass it as `where`.

**`withRequester` and lazy queries.** A Drizzle query builds its statement — and
reads the requester context — when it is awaited. `withRequester(ctx, () => …)`
awaits the callback's value inside the context, so returning an un-awaited
`db.query…` from the callback is safe.

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
- **`unique: true`** — returns a single row (or null) instead of an array. A
  finder hint only: it emits no DDL. Declare the constraint with field
  `unique: true` or `unique_indexes:`.
- **`order: <col> <dir>`** — default ordering for the finder (e.g. `created_at
  desc`).

### Filtered search

```yaml
queries:
  - name: search                  # → SearchContacts use case + GET /contacts/search
    filters: [user_id, account_id, email]   # optional equality filters
    search: name                  # ilike column for free-text
```

A `name: search` query generates a search use case and a `GET /<plural>/search`
route. Search is the list endpoint with filters: the route takes the list's
query (`page`, `pageSize`, `cursor`, `sort_by`, `sort_order`) plus one optional
param per filter (and `search`), and returns the same `Page<T>` envelope as
`GET /<plural>` (`{ items, page, pageCount, total, pageSize, nextCursor }`). The
use case ANDs the filters into a `where` and pages through the list use case, so
paging defaults, the page-size clamp and sort are the list's. There is no
`paginate:` or `order:` key on a search — either is a validation error.

## Non-obvious rules

- **Finder names are generated** from the column list — don't also hand-write a
  finder of the same name; compose on top instead.
- **Unique finders return a single nullable result**; non-unique return arrays.
- **`order:` is the default sort** of a `by:` finder, not a parameter — add a
  `queries:` search entry if you need caller-controlled ordering (`sort_by` /
  `sort_order`, as on the list).
- **Family methods assume their columns exist.** `Integrated` expects the
  external-id + provider shape (its implied `external_id_tracking` behavior
  emits it). It adds **no** user-ownership finder — a global integrated table
  (reference data) has no `user_id`. If yours is user-owned, declare the
  `user_id` field and a `queries: [{ by: [user_id] }]` finder; `Activity`'s subject finders expect the subject FK
  named by its `config:` (`subject: person` → `person_id`, or an explicit
  `subjectColumn`) plus a recency column (`occurred_at` by default, or
  `config.occurredAt`). If your table doesn't fit, pick `Base` and add explicit
  `queries:`.
