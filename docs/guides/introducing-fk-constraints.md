# Introducing FK Constraints on Existing Tables

When you add `on_delete:` to a `belongs_to` relation for the first time, the
next Drizzle migration will emit an `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY`
statement. Postgres validates **all existing rows** at the moment that statement
executes. If any child row references a parent that no longer exists, the
migration fails with:

```
ERROR: insert or update on table "messages" violates foreign key constraint
  DETAIL: Key (conversation_id)=(…) is not present in table "conversations".
```

This guide covers two paths for handling that situation.

---

## Option 1 — Orphan detection + cleanup (preferred for small tables)

Run this SQL template **before** applying the migration. It surfaces every
child row whose referenced parent is missing. Review the results, then either
delete the orphans or re-parent them.

```sql
-- Replace <child_table>, <fk_column>, and <parent_table> with real names.
-- Example: child=messages, fk_column=conversation_id, parent=conversations

SELECT child.*
FROM <child_table> child
LEFT JOIN <parent_table> parent ON parent.id = child.<fk_column>
WHERE parent.id IS NULL;
```

Concrete example for a `message → conversation` relationship:

```sql
SELECT messages.id, messages.conversation_id, messages.created_at
FROM messages
LEFT JOIN conversations ON conversations.id = messages.conversation_id
WHERE conversations.id IS NULL;
```

Once you've cleaned up the orphans, apply the migration normally. Postgres will
validate the constraint successfully because no orphan rows remain.

**When to use this option:**
- Table has < ~10 M rows (constraint validation is fast and holds an AccessShareLock
  for milliseconds to seconds, not minutes).
- You can tolerate a brief window where new orphans could be created between
  cleanup and migration (acceptable if the table is low-write or in a maintenance
  window).

---

## Option 2 — `NOT VALID` + background validation (for large tables)

For large tables where holding a lock during full-table validation is
intolerable, Postgres supports a two-step process:

**Step 1 — Add the constraint without validating existing rows.**

```sql
ALTER TABLE <child_table>
  ADD CONSTRAINT <child_table>_<fk_column>_fkey
  FOREIGN KEY (<fk_column>)
  REFERENCES <parent_table>(id)
  ON DELETE <action>
  NOT VALID;
```

`NOT VALID` means the constraint is enforced for new writes immediately, but
existing rows are not checked. The lock held is much shorter (it only needs to
block concurrent DDL, not scan the table).

**Step 2 — Validate existing rows in the background (concurrently).**

```sql
ALTER TABLE <child_table>
  VALIDATE CONSTRAINT <child_table>_<fk_column>_fkey;
```

`VALIDATE CONSTRAINT` performs a sequential scan and holds a `ShareUpdateExclusiveLock`
(non-blocking to readers and writers) for its entire duration. Run this during
off-peak hours or in a maintenance window. It will fail if orphan rows exist —
clean them up first (Option 1 above).

**When to use this option:**
- Table has tens of millions of rows and the migration runs in a production
  environment where a long AccessShareLock is unacceptable.
- You are comfortable leaving the constraint in `NOT VALID` state temporarily,
  understanding that existing orphans are not blocked by the constraint until
  validation completes.

---

## Drizzle / toolchain notes

Drizzle's migration generator emits a standard `ALTER TABLE … ADD CONSTRAINT`
without `NOT VALID`. If you need the two-step approach, you have two options:

1. **Edit the generated migration file** to add `NOT VALID` before applying it,
   then run the `VALIDATE CONSTRAINT` statement manually after cleanup.
2. **Write the two steps as separate raw SQL migrations** (use Drizzle's
   `sql` escape hatch in a custom migration file).

Neither approach is automated by the scaffolder — this is a one-time manual
step when introducing FKs on a table that already has data.

---

## Soft-delete caveat

If the parent entity uses `soft_delete`, a parent row may be *soft-deleted*
(has a non-null `deleted_at`) while children still reference it. That is **not**
an orphan from the database's perspective — the parent row still exists, so the
FK constraint is satisfied.

Only hard-deleted rows (physically removed via `DELETE`) produce FK violations.
See [ADR-021](../adrs/ADR-021-on-delete-semantics.md) for the full treatment of
how `on_delete` interacts with soft-delete semantics.

---

## Related

- [ADR-021 — On-Delete Semantics for Generated Relations](../adrs/ADR-021-on-delete-semantics.md)
- Drizzle ORM docs: [Foreign Keys](https://orm.drizzle.team/docs/indexes-constraints#foreign-keys)
- Postgres docs: [`ALTER TABLE … ADD CONSTRAINT … NOT VALID`](https://www.postgresql.org/docs/current/sql-altertable.html)
