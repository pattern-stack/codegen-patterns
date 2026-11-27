## Gate 2.5 — Adherence (lens=adherence) · PR #909 @ 0da03c9f

**Against:** RFC-0006 §12 (A8, A9, A12 manifest half) + §13.2 S3 (plan, "as built", phase R, phase R2)
**Verdict:** PASS_WITH_NOTES

Reviewed tip `0da03c9f` in the worktree, diffed against `dugshub/875-s2-inherits-ddl` (`d7176186`). The PR head `2a6e5b04` is
the same two patches rebased onto main (`git range-diff`: both commits `=`). The three earlier rounds on the PR were read,
and every claimed fix below was re-checked at the tip.

All three acceptance items this slice claims are met, with evidence. Nothing the slice "must not touch" was edited.
Every finding is a place where the RFC, or a doc it binds, says something the code does not do. Two of them would mislead
a later slice.

### Blockers

None.

### Should-fix

1. `docs/rfcs/RFC-0006-joined-table-inheritance.md:1395-1400` — the as-built bullet "**`includes` follows the family**"
   is wrong at the tip in two ways.
   - (a) It says the rule is "decided after `familyReads` in `entity-locals.js`". There is no `includes` local any more.
     The rule is `hasTypedInclude` (`src/derived/api/entity.ts:158`), and the templates read it as
     `apiSurface.repository.typedInclude`.
   - (b) It says "HTTP behaviour is unchanged (`?include=` is still a 400, the allowlist is S5's)". The phase-R bullet in
     the same entry (`:1426-1431`) and the code say otherwise. `build-includes.ts:166` now accepts `api.includes` on a
     child, and on a base that has children. `typedInclude` is true for both. So `controller.ejs.t:156-208` wires the
     compiled allowlist (`_allow(r)` via `includeRoute`, `src/derived/api/entity.ts:732-734`), and
     `GET /meetings/:id?include=communication` resolves in S3, not S5.

   **Scenario:** the S5 agent reads that the allowlist for a family member is S5's to open. They either re-plan work that
   has already landed, or treat the S3 gate change as a regression and narrow it again. **Fix:** rewrite the bullet to
   match the tip. Name `hasTypedInclude` as the owner, and say that S3 opens `api.includes` for family members. HTTP is
   unchanged only where no `api.includes` is declared, which is true of every fixture.

2. `docs/rfcs/RFC-0006-joined-table-inheritance.md:839` and `:1117`, plus `test/fixtures/inheritance/entities/communication_part.yaml:4`,
   `test/scaffold/entities/communication-part-scaffold.yaml:5` and `test/smoke/fixtures/communication_part.yaml:5` — these
   still say "`message` stays a base-only kind" of `communication_part`, and §13.1's fixture table (`:1117`) lists only
   two children. S3 added `message_communication_part` (`inherits: { base: communication_part, as: message }`) in all
   three harness sets. The family now has 13 entities (`inheritance-schema.test.ts:17`), and **every** kind of
   `communication_part` (`meeting`, `email`, `message`) has a child table. The as-built names the new entity only in
   passing (`:1398`), and §13.1 is the table every slice is told to work from.

   **Scenario:** A10 (S5) says "the base's create accepts only base-only kinds". An agent working from §7 and §13.1
   writes a `communication_part` base-create case that posts `kind: 'message'` and expects success. On this fixture set
   that kind has a child table, so the base create has no legal kind at all. The test is wrong before it runs, and the
   soft-delete family has no base-only kind left to cover the restricted create. **Fix:** add `message_communication_part`
   to §13.1's table (a fields-only child of `communication_part`, kind `message`, added in S3). Correct §7's comment and
   the three fixture comments. State in §13.1 that `communication_part` now has no base-only kind and that A10's
   restricted create is covered on `communication` only. If base-only coverage on the soft-delete family matters to
   S4/S5, that is a fixture-design call: **DECISION**.

### Nits

3. Files touched beyond §13.2 S3's "Touches" list that neither the as-built nor §10 names:
   - `tools/studio/src/inspector/surface-kinds.ts:82-88,103-109` and `tools/studio/src/__tests__/surface-view.test.ts`.
     Studio is S6's, and §10 row 10 (`:1003`) lists only `relationship-kinds.ts` / `edge-kinds.ts`.
   - `runtime/base-classes/with-communication.ts:153`.

   Both edits are forced. `Record<RepositoryKind, …>` is exhaustive, and the `softDelete` flag now has one meaning. S3's
   gate list (`:1336`) also lacks `just test-studio`, which is the only gate that typechecks the Studio edit (it runs
   inside `test-all`). **Fix:** one as-built line naming both files and why; add the derived surface
   (`src/derived/api/*`, `hasTypedInclude` and the include gate) and `surface-kinds.ts` to §10; add `just test-studio`
   to S3's gates.

4. `src/derived/api/entity.ts:149-153` — the `hasTypedInclude` docstring says "yes when its table carries an edge in the
   relations manifest. Three things put one there". The code also counts `cardinality: one` roles (`mergedRelationships`),
   and those put **no** edge in the manifest. `build-graph.ts:502` is a comment-only CAP-2 seam, and
   `build-includes.test.ts:485` says "REL-1's graph reads `relationships:` only". The RFC (`:1426`) lists four causes, the
   docstring three. RFC `:1431` "Both are accepted now" also overstates the role case: it passes the gate, and every role
   path is then refused (`build-includes.test.ts:495`, `names no relation at 'caller'`). **Fix:** have the docstring list
   the role case and say it has no manifest edge until CAP-2. Have the RFC say the role-only block passes the gate but a
   role path is still refused at path resolution.

5. `docs/rfcs/RFC-0006-joined-table-inheritance.md:1072` (A9), "`.toSQL()` in `just test-unit`" — what was built differs
   from that text in two ways.
   - The unit spec records statements through a fake `pg` client rather than calling `.toSQL()`, and it runs on a hand
     copy. Its header claims "EXACTLY the shape" the template emits (`inheritance-read-sql.spec.ts:4`), but the copy is
     not exact: `findOrphans` inlines what the template puts in `<e>OrphanFilter`, `findWithBase` drops `columns` and
     `with`, and `findOne` / `findWithChild` are not generated methods.
   - The one-statement check on generated code is `inheritance-reads.test.ts` "A9 — each generated family read is ONE
     statement" (`just test-integration`).

   **Scenario:** a template edit that makes `findAllKinds` issue two statements leaves `just test-unit` green. Only
   `test-integration` goes red, but A9's text names test-unit as the gate. **Fix:** name both gates in A9's parenthetical,
   and soften "EXACTLY" in the spec header. Change no assertion.

6. `docs/rfcs/RFC-0006-joined-table-inheritance.md:482` ("so the hop cannot drop it") and `build-graph.ts:372` ("The edge
   is never null") conflict with as-built `:1353`, which says a hand-written `{ softDelete: false }` returns deleted rows
   "on a child as on a table".
   - Under that flag the child root drops the base `EXISTS` (`base-repository.ts:556-559`).
   - The child-to-base hop still applies `hopScope(t, COMMUNICATION_PARTS_SCOPE, …)`, so it still drops a soft-deleted
     base.
   - So `with: { communicationPart: true }` returns `null` where the type says non-null. `flattenBase` on that row would
     return no base columns, typed `…Flat`.

   On a table the dropped hop is typed `optional: true`, so "as on a table" is not quite true. No generated read reaches
   this; only a subclass calling `this.scopeAnd(…, { softDelete: false })` with a base `with` does. **Fix:** reword to
   "never null under the read guards" and state the limit next to `:1353`.

7. `docs/rfcs/RFC-0006-joined-table-inheritance.md:900-901` — §8's cost table gives a child read with its base, and a
   cross-kind read, as only primary-key lateral joins. In a `soft_delete` or `user_tracking` family each also carries the
   base `EXISTS`: at the child root, and on every child hop of a cross-kind read (`inheritance-read-sql.spec.ts:379`). Row
   `:899` states it only for the table-shaped read. **Fix:** add "plus the base `EXISTS` when the base declares
   `soft_delete` / `user_tracking`" to both rows.

8. `templates/entity/new/backend/repository.ejs.t:38-39` (`_EU`, `_eLower`). This builds on the deferred round-2 #5. The
   follow-up at RFC `:1446` belongs to no slice and no issue, and the deferral is recorded only in the RFC.
   - CLAUDE.md `:430` still says "Two things are still decided outside the derivation".
   - `no-name-derivation-in-templates.test.ts` cannot see these two spellings: its pattern is
     `.charAt(0).toUpperCase()`, and these are `.charAt(0).toLowerCase()` and `.toUpperCase().replace(…)`.
   - So "the allowlist did not grow" (`:1445`) holds because the lint is blind to these spellings, not because nothing
     case-changes a name.

   **Fix:** name the third exception in CLAUDE.md's "Templates print" paragraph, and give the follow-up an owner.
   **DECISION:** S4, S5 or a filed issue.

9. `docs/specs/REL-2.md:894` — the dated note "Revision (2026-11-14, ADR-046 B3)" still says, in the present tense,
   "`declaresOwnRelation` and `apiEnabled` live in `src/derived/api/entity.ts`". The body above it was updated to
   `hasTypedInclude`, and ADR-046 got a dated revision for the same change. **Fix:** add a dated line (2026-11-15) saying
   `hasTypedInclude` replaces it (RFC-0006 #875).

### Checked and fine

- **A8, the soft-delete base.**
  - At the root, the generated `TranscriptCommunicationPartRepository` `list` / `findById` / `findByIds` drop a child
    whose base is soft-deleted, and the row is proven present by raw SQL.
  - At a hop, `db.query.communication_parts … with: { transcriptCommunicationPart }` drops it, and restoring the base
    brings it back (`inheritance-reads.test.ts` "A8 — soft_delete …").
  - The SQL is pinned at the root, at a hop and through `scopedRoot` (`inheritance-read-sql.spec.ts` "A8 — …").
- **A8, the tenant.**
  - At the root: `MeetingRepository.list` / `findById` for both tenants, strict with no ambient tenant.
  - At the hop in both directions: `communications → meeting` and `meetings → communication`.
  - Over HTTP: `GET /meetings` and `GET /meetings/:id`, 200 for the caller's row and 404 for another tenant's
    (`inheritance-scope-http.test.ts`).
- **A9.**
  - One statement each for `findAllKinds` (with and without `kinds`), `findKindById`, `listKind`, `countKind`,
    `findOrphans`, `findWithBase` and `findManyWithBase`, counted on the generated repositories, with a control that
    sees 2 statements.
  - The union: each child under its own key, the other keys removed, the base-only `message` bare.
  - `OrphanBaseError` from both `findAllKinds` and `findKindById`.
  - `findOrphans` returns exactly the orphan, and never another tenant's.
- **A12, the manifest half.** `inherits-graph.test.ts` checks:
  - both edges, the `inherits` marker and the `optional` flags;
  - that the key is the entity name and not `as`;
  - the `baseScope` literal and the rendered manifest text;
  - an error for a child whose base is missing.

  The baseline `relations.ts` matches §3.1's fragment.
- **§2.3.**
  - The `EXISTS` is emitted only when the base declares `soft_delete` or `user_tracking`.
  - The tenant axis is not repeated on the base.
  - A tenant-only family emits no `EXISTS` (spec: "a tenant-only family emits NO exists").
  - `isUnscoped` and `isUnscopedConfig` count `baseScope`.
- **§6 and the generated code agree** on `findWithBase`, `findManyWithBase`, `<E>Flat<W, C>`, `findAllKinds`,
  `findKindById`, `listKind<K extends keyof <E>FlatByKind>`, `countKind`, `findOrphans`, `<E>OfKind` and `<E>Kind`, and
  each is forwarded by the service. This PR's edits to §6 (`Flattened`, `listKind`) match `inheritance.ts:20` and the
  baseline output.
- **Must-not-touch holds.**
  - No edit to the create / update / delete bodies, to `dto/*`, `use-cases/*`, `controller.ejs.t` or `module.ejs.t`, or
    under `src/emitters/frontend/`.
  - Baseline controller and use-case bytes change only through the `typedInclude` flip, which is documented.
  - The child's inherited by-id writes gain only the base's `user_tracking` guard, which no fixture declares; S4
    overrides those writes.
- **Every runtime read path passes `softDelete: true`.** Checked every `scopeAnd`, `scopeAndOn`, `rootFilter` and
  `scopeConfigFor` call site in `runtime/`. The by-id write and integration paths pass nothing, on purpose. No read path
  still masks a child's base guard with `behaviors.softDelete`.
- **`inheritanceChildrenOf` has one owner**, read by the derivation, `familyReads` and the include gate. A base with no
  entity lookup throws (`family-reads.test.ts`). `matrix-discriminator-no-child`: a `discriminator:` base with no child
  gets no family reads and no typed include.
- **`declaresOwnRelation` is gone from all code.** ADR-046 has a dated revision note, and PLAN.md's grep row still
  yields 3.
- **Runtime wiring.** `inheritance.ts` is exported from `index.ts`, listed in `VENDORED_RUNTIME_FILES` and imported via
  `inheritanceImport`. Package mode resolves through the `./runtime/*` export.
- **Fixtures.** The three copies of `message_communication_part` are identical, and the agreement test requires it in
  every set. `run-integration.ts` runs all of `test/scaffold/tests/`, so both new suites run.
- **Not re-verified (gates not run, per the lane):** A15's red-then-restored mutation claims (`:1415-1417`), and the
  claim that render goldens are byte-identical apart from the new case.
