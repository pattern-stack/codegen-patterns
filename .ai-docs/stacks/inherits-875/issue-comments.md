# Draft issue comments for #875 — DO NOT POST until Doug says so

Written by lane `inh-s6-build` (2026-11-14), corrected after the S6 review. One section per issue: what landed in #875
(RFC-0006, the six-PR stack S1–S6) and what stays in the issue. No host-application names; PR numbers for the coordinator
to fill in.

---

## #780 — natural keys

**Landed in #875.**

- **OQ-10, #780's first open question, is settled:** a natural key is declared as `natural_key: true` on one
  `unique_indexes` entry, not as a separate top-level `natural_key: [fields]`. The index is already declared in
  `unique_indexes`, and one entry cannot be declared twice. At most one entry per entity; every column NOT NULL (a NULL never
  conflicts, so it could never be the `ON CONFLICT` target); none on a joined-table child (it upserts on its base's key).
- **The single-row `upsertByNaturalKey(input, tx?)` now exists on every `natural_key` entity**, family or not — not only on
  `inherits:` entities. It is one `INSERT … ON CONFLICT (<key>) DO UPDATE … RETURNING`, scoped like every other write (tenant
  in the key under `tenant_scoped`; the ambient user predicate in the conflict's `WHERE` under `user_tracking`, so one user
  cannot overwrite another's row). Result `{ row, created }` (`xmax = 0`); for a joined-table child `{ row, created, baseCreated }`. A child gets `upsertByNaturalKey` through its base's key; a child whose base declares none has no upsert.
- **OQ-14's semantics** (what the issue left open for a soft-deleted match): the row is **updated and stays deleted** —
  `deleted_at` is not in the `SET` list. A provider re-sending an object is not a decision to undelete it. Reviving is the
  caller's decision, and one line to change.
- The service wraps it and emits `created` / `updated` events from the result (a family emits under both the child's and the
  base's names).

**Stays in #780.** The batch form (`upsertManyByNaturalKey`); the **update policies** the issue names — overwrite, coalesce,
keep-first (#875 builds only "overwrite the supplied columns"); `findByNaturalKey(...)`, the unique finder (the existing
`queries: [{ by: [...], unique: true }]` still produces it; #875 adds no dedicated one); a natural key containing a nullable
column (R11 refuses it today, and RFC-0006 §4.2 notes S7 would widen R11 to behavior columns); and the `Integrated`-pattern sink
built on the upsert (RFC-0006 S7, its own issue when a consumer writes a family through the generated sink).

---

## #786 — `checks:`

**Landed in #875.**

- **An internal check builder exists.** A check is a `tableConstraints` entry with `builder: 'check'` in `entity-locals.js`,
  rendered as `check('<table>_<name>', sql\`…\`)`. #875 uses it for the joined-table child's `kind = '<as>'` CHECK and for the
  `match:` CHECK (below). Constraint and index names now go through one 63-byte check for every entry (a name over Postgres's
  limit is a generation error; Postgres would truncate it silently). The `checks:` key in #786 can emit its entries through
  the same list.
- **There is still no user-facing `checks:` key.** The entity schema is `.strict()`, so writing it is an unknown-key error.
  OQ-11 (decided 2026-11-13): the rule that motivated it here — "a part's kind fits its communication's kind" — is expressed as
  `choices_of:` plus `match:` on the discriminator, i.e. one composite FK, with no CHECK.
- The one CHECK #875 emits besides the kind check is the `match:` one, and it is **one-directional**:
  `<table>_<relationship>_match_check` is `<fk> IS NULL OR <derived> IS NOT NULL`, so a set FK always has its derived column;
  a derived column with no FK is allowed.
- Generator-wide, same build: every table callback's single parameter is `tCols` (one name for every table, #813), which is the
  identifier a user CHECK expression would reference.

**Stays in #786.** The user-facing `checks:` key itself (shape, naming, validation of the expression), and `min` / `max`
emission as CHECK constraints. Nothing in #875 pre-empts either.

---

## #787 — composite foreign keys / `match:`

**Landed in #875.**

- **The explicit `match:` form for a DERIVED local column, and the composite-FK emitter.** On a `belongs_to`:
  `match: { <local column>: <target column> }` (or `[col]` for `{ col: col }`) emits one composite FK `(<fk>, <local columns>) →
  <target>(id, <target columns>)`, and the target gets the `unique(id, <cols>)` it needs, rendered by the target's own template
  from its referrers' YAML so `entity new` in any order gives the same bytes. The local column is **not declared by the author**:
  it takes the target column's type and is filled by a scalar subquery on insert, immutable while the FK is unchanged (M1–M5,
  RFC-0006 §2.4). The `match:` composite FK takes the relationship's own `on_delete`. A `match:` whose FKs are all nullable
  makes the derived column nullable, with the one-directional CHECK `<fk> IS NULL OR <derived> IS NOT NULL`; two relationships may
  match one local column when the target columns have the same SQL type.
- **Open question 3 (`match:` generality) is answered:** any list of target columns is accepted, not only the tenant and a
  version column — but only as a derived column, with the one exception M2 allows (the entity's own `discriminator:` field,
  when its enum is the target column's via `choices_of:`).
- **`choices_of: <entity>.<field>`** (OQ-13): an enum field that is the same Postgres type as another entity's enum, so a
  composite FK between two enum columns type-checks. Every entity that declares an enum now emits it into a leaf
  `<entity>.enums.ts`, which is what makes the cross-entity import safe at boot.
- The same emitter pins a joined-table child's tenant: a second composite FK `(id, tenant) → base(id, tenant)`.

**Stays in #787.**
- **The shared-declared-column case — the issue's own example.** `heading: { match: [revision_id] }`, where `revision_id` is a
  column the child already declares and shares with the parent, is **refused by M2** (a `match:` local column may not be a
  declared field or FK column). #875 builds the derived-column form only.
- **The implicit same-tenant FK on every tenant-scoped `belongs_to`** (OQ-12): it changes the DDL of every tenant-scoped
  relationship and needs a NOT NULL tenant column on every entity, not only on bases, so it is its own decision (open questions 1
  and 2 are unchanged).
- **`cross_tenant: true`**, the deliberate opt-out of that default.
- **The use-case half:** the generated create / update checking the parent through its tenant-scoped repository and returning a
  422 naming the field, instead of a `23503`.
- Open question 4 (relation-graph through-joins relying on the composite FK) is untouched.
