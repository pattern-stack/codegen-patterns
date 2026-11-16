# Slice 2, first piece: the columns that come from elsewhere, and Studio's FK rows

**Status:** approved by the owner on 2026-11-16. Not started. It starts after #933 (STUDIO-5) and #934 (STUDIO-6)
merge, as a two-PR `gh stack` off `main`. It is ADR-046 slice 2's first piece (`PLAN.md` §11), and it touches #892.

## The ask

Today a Studio card lists only the entity's YAML `fields:`. Every column that comes from somewhere else exists on the
canvas only as a line between cards:

- a `belongs_to`'s FK column (e.g. `owner_id`);
- the inherited `id` of an `inherits:` child, which is both its PK and an FK to the base;
- the columns a `match:` derives (e.g. a derived `kind`, or a `<parent>_id`);
- the tenant column on a tenant-scoped entity.

The owner wants these shown the way dbdiagram.io shows them:

1. **Rows on the card**, marked by source (FK, inherited PK→FK, derived by `match:`, tenant), and set apart from the
   declared fields: muted, or in their own group.
2. **Lines land on columns**, not card edges: on the FK row on the holder's side, and on the referenced column on the
   target's side. That column is usually `id`, or the composite target of a `match:`.
3. **`VISIBLE_FIELDS` collapsing still applies,** except that a row a drawn line lands on is never hidden.

The spine and secondary-line rules (STUDIO-3, STUDIO-6) do not change. The owner sees screenshots before it merges.

## Why it is two PRs, server first

`/api/graph` cannot carry this today. `src/studio/shared/api.ts` has a `belongs_to`'s `foreignKey` and `onDelete`, and
an entity's `inherits` (`base`, `as`). It has no `match:` pairs and no tenant column. Rebuilding those in
`tools/studio` would be a second derivation of DDL facts, which ADR-046 forbids: a fact about the generated output is
derived once, in `src/derived/`, and carries the YAML path that caused it.

### PR 1: the derivation (`src/derived/columns/`, served in `/api/graph`)

Per entity, every column the entity's table has that its own `fields:` did not declare:

```ts
interface DerivedColumn {
  name: string;                                   // the SQL column, e.g. owner_id
  source: 'fk' | 'inherited-pk' | 'match' | 'tenant';
  references?: { entity: string; columns: string[] };  // the target: usually ['id']; a match: may be composite
  relationId?: string;                            // the relation that caused it, for the line to land on
  path: string;                                   // the YAML path that caused it (ADR-046 provenance)
}
```

- **Read the existing owners. Never restate them.**
  - the `belongs_to` FK column: the parser's `foreignKey`;
  - the inherited id: `inherits:`;
  - `match:` pairs: `matchPairsOf` (`src/schema/inheritance.ts`);
  - the tenant column: `tenantColumnName` (`src/schema/tenancy.ts`).
- **Serve it** on each serialized entity in `/api/graph` (`src/analyzer/serialize-graph.ts`, with the type in
  `src/studio/shared/api.ts`).
- **Gates**, the same terms as ADR-046 Phase A:
  - parity against generated output: every derived column exists in the emitted Drizzle entity file, with the
    reference it claims, over the baseline fixtures, the joined-table-inheritance fixture and a `tenant_scoped` case;
  - a golden that pins the provenance;
  - the Studio e2e asserts the payload against a really generated project.
- **#892.** Its second copy (Studio's `fkUnique`) was deleted with the unique-FK spine tier when #875 landed. What
  remains is the unique-constraint derivation and the partial-unique semantic, both of which belong in the same
  `src/derived/columns/` home. Update #892 to say so. Folding the unique constraints in is slice 2's next piece, not
  this PR, unless it falls out for free.

### PR 2: the UI (`tools/studio/src/**`)

- **Card rows:** the derived columns go in their own muted group under the declared fields, each with a source badge
  (FK, PK→FK, match, tenant). Colours come from tokens only (`index.css` `light-dark()` pairs).
- **Line endpoints:**
  - a line meets the holder at its FK row, and the target at the referenced column's row;
  - for a composite `match:` target, at the first column of the pair (or spanning the pair; decide with screenshots);
  - `graph/edge-geometry.ts` gains row anchors;
  - the card-edge sides stay as the fallback until ReactFlow has measured the card.
- **Collapsing:**
  - `VISIBLE_FIELDS` is defined in `graph/SchemaNode.tsx` and mirrored in `layout/tree-layout.ts` for card heights.
    Make it one exported constant, since the height rule now also counts derived rows.
  - A row a drawn line lands on is never collapsed.
- **Must check: "adding or removing a secondary line moves no card".** Adding a `belongs_to` now also adds an FK row,
  which makes its holder taller. The existing tests must stay unchanged and green. If adding a row would move cards
  below, stop and put the options to the owner. One option: the layout reserves the derived group's height from the
  derivation, which a line does not change.
- **Sign-off:** screenshots in light and dark at 1440×900, with the inspector open and hidden, on the demo and the
  joined-table-inheritance fixture, before merge.

## Rules

- **Public repo.** Fixtures and docs use generic names; never a host application's names, paths or tables.
- No merges and no auto-merge by agents. The owner or the lead merges.
- Commit trailers as in `ORCHESTRATE.md`.
