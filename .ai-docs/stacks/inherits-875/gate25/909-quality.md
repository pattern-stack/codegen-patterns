## Gate 2.5 — Quality (lens=quality) · PR #909 @ 0da03c9f

**Against:** CLAUDE.md + quality canvas + reuse/layering
**Verdict:** REVISE

Reviewed at the local tip `0da03c9f` (`git diff dugshub/875-s2-inherits-ddl...HEAD`). `0da03c9f` is the rebased
form of the PR's pushed head `2a6e5b04`: same two S3 commits, on the rebased S2. The four rounds of earlier review
on the PR were read first, and nothing they mark as fixed is reported again here. Every finding below was checked
at the tip. There are no blockers. All three should-fix items are on code this PR adds.

### Blockers
None.

### Should-fix
1. `templates/_shared/inheritance.mjs:319`, `:348` vs `src/emitters/relations/build-graph.ts:363`, `:380`
   **Defect:** the relation key of a family edge is a new concept in this PR, and it is derived twice with two
   different case primitives. The manifest names the edge with `camelCase` from `src/emitters/relations/types.ts:142`
   (`/[-_\s]+([a-zA-Z0-9])/`). The repository template's `relKey` (`familyReads`) uses `camelCase` from
   `src/config/file-naming.ts:55` (`/_([a-z])/`). The two disagree on any name with a digit after an underscore:
   `part_2` comes out `part2` against `part_2`, and `note_2x` comes out `note2x` against `note_2x` (checked with
   `bun -e`). The entity-name schema allows such names (`/^[a-z][a-z0-9_]*$/`).
   **Scenario:** a child `call_2` that `inherits: communication`. Its manifest edge on `communications` is `call2`.
   The generated base repository prints `COMMUNICATION_CHILD_KEY_BY_KIND = { call_2: 'call_2' }` and
   `communicationKindJoins` returns `{ call_2?: true }`, so `with: { call_2: true }` names no relation. Generation
   succeeds, and the consumer's `tsc` (or RQBv2 at runtime) fails. The same split applies to a base named `comm_2`:
   its children's `findWithBase` uses `with: { comm_2: true }` against the manifest's `comm2`. No test catches it,
   because no fixture name has a digit segment. (`inherits-graph.test.ts:75` pins the manifest side only.)
   **Fix:** make the key one function, e.g. `familyRelationKey(entityName)` next to `inheritsOf` in
   `src/schema/inheritance.ts`. Have `build-graph.ts` and `familyReads` both call it. Implement it with the
   manifest's primitive, because the manifest is what a `with` key must match. Add a fixture name with a digit
   segment, or a direct unit test of that agreement.

2. `templates/entity/new/backend/repository.ejs.t:466-500` (`findWithBase` / `findManyWithBase`), `:518-543`
   (`findAllKinds` / `findKindById`), `:550-568` (`listKind`)
   **Defect:** the family reads restate the READ-1 read bodies instead of calling them. `findWithBase` is
   `findById`'s body with one extra `with` key. The header comment says it plainly: "`findWithBase` is `findById` with
   the base joined in". `findManyWithBase` copies `findByIds` line for line: `uniqueIds`, the
   `assertReadScope()` on `[]`, `byIdsColumns`, `inInputOrder`. `findAllKinds` and `listKind` copy `list`'s
   `where` / `orderBy` / `limit` / `offset` assembly. The runtime docstring claims "There is no second query path
   here" (`runtime/base-classes/inheritance.ts:7-9`). The text is a second copy anyway, and
   `no-unscoped-db-query.test.ts` now counts 12 relational-read sites where it counted 6. (Category: duplication / one
   owner.)
   **Scenario:** `findByIds`' own docstring records an open limit: "Not chunked: Postgres caps a statement at 65 535
   parameters". The day `findByIds` gains chunking, or any other change to READ-1's contract (a new boundary check, a
   new mask rule), `findManyWithBase` keeps the old behaviour, and nothing fails. The same goes for `list` and the two
   cross-kind lists.
   **Fix:** print the family reads as projections over the READ-1 methods. `findWithBase(id, opts)` becomes
   `this.findById(id, { ...opts, with: { ...opts?.with, <relKey>: true } })` then `flattenBase`. `findManyWithBase`
   becomes `this.findByIds(…)` then `.map(flattenBase)`. `findAllKinds` / `listKind` become
   `this.list({ ...query, where, with: <e>KindJoins(kinds) })` then `asKind`. `findKindById` becomes
   `this.findById(id, { with: <e>KindJoins(undefined) })`. A child always has a typed include (`hasTypedInclude`), and
   so does a base with children, so the generic `with` is available. Each read stays one statement, and the scope
   lives in one body.

3. `runtime/base-classes/scope-filters.ts:234-237`, and the `baseScope.userTracking` path end to end
   **Defect:** the PR body claims "a child of a soft-deleted **or user-tracked** base is filtered by one `EXISTS`".
   The user-tracked half has no test that could fail. Every `baseScope` in the suite is
   `userTracking: false`: `inheritance-read-sql.spec.ts:88`, `:284` and `inherits-graph.test.ts:137`. No fixture base
   declares `user_tracking` (the `communication*` bases are `[timestamps]` / `[soft_delete]`). Nothing covers the
   `userScopePredicateFor(base.table, cfg.enforcement, owner)` branch inside the `EXISTS`, nor
   `emit-manifest.ts`'s `userTracking: true` rendering, nor a strict-enforcement child whose base's user axis has no
   ambient user. (Category: test coverage on a security posture.)
   **Scenario:** delete the `if (base.userTracking) { … }` block, or pass the child's `table` instead of `base.table`
   to `userScopePredicateFor`. Every gate stays green, and a child of a `user_tracking` base becomes readable by any
   user in the tenant, at the root and at every hop.
   **Fix:** add a `user_tracking` base to `inheritance-read-sql.spec.ts`, asserting the rendered
   `exists (select 1 from "<base>" where … "<base>"."<owner col>" = $n)` at the root and at a hop, and the strict
   throw with no ambient user. Add one `inherits-graph` case for the manifest literal. One scaffold case would close it
   against Postgres.

### Nits
4. `templates/entity/new/backend/entity-locals.js:2090` — `familyChildren` is a second
   `inheritanceChildrenOf(entityName, …)` call. `familyReads` made the same call 10 lines earlier, through the same
   lookup. This one also carries `entityLookup?.definitions ? … : []`, a permissive default that
   `EntityApiInput.inheritanceChildren` (`src/derived/api/entity.ts:213-217`) says must not exist ("Required, not
   defaulted"). Today the default can't be reached for a base: `familyReads` throws first for a `discriminator:`
   base, and R1 means a base without one has no children. Even so, it is the rule stated, and then contradicted, in one
   file. (`convenient_fallback`.) **Fix:** take it from `family.base?.children` (`{ name, as }`), which leaves one
   call and no fallback.

5. `src/derived/api/entity.ts:137`, `repository.ejs.t:33-35`, `service.ejs.t:18-19` — the family-read kind set is
   written out three times: `isFamilyReadKind` (six kinds), plus `_ACROSS` and `_isRead` / `with_base || _isAcross ||
   orphans` in each template. A seventh family read means editing three lists. The parity gate catches the miss, but
   only after the fact. (`magic_constants`.) **Fix:** carry the grouping on the derived method (e.g. `family: 'child'
   | 'cross_kind'`, or one exported `FAMILY_READ_KINDS`), so the templates branch on a flag.

6. `repository.ejs.t:47-51` — `_familyOrm` filters itself against the other two `drizzle-orm` import lines
   (`!(n === 'and' && hasMultiFieldQuery) && !(n === 'sql' && eavValueTable)`). The emitted base repository now has
   two `import { … } from 'drizzle-orm'` statements (baseline `communication.repository.ts:4-5`), and the next
   conditional import has to know about all three. **Fix:** compute the specifier set once and print one import.

7. `src/emitters/relations/types.ts:80-87` — the `RelationEdge.inherits` docstring says "The backend reads it for the
   `optional: false` exception". Nothing outside tests reads `edge.inherits` at this tip. `optional: false` is set
   literally at construction (`build-graph.ts:373`). Until the frontend emitter starts reading the marker (the
   docstring places that in S6), the marker has no reader. **Fix:** say that: "set here, read by the frontend emitter
   from S6; the backend's `optional: false` is fixed at construction."

8. `src/derived/api/entity.ts:148-152` — the `hasTypedInclude` docstring says "yes when its table carries an edge in
   the relations manifest. Three things put one there…". The function also returns `true` for an entity whose only
   edge is a `cardinality: one` role (via `mergedRelationships`), and REL-1 puts no role edge in the manifest. The
   PR's own test shows it: past the gate, a role-only `api.includes` fails at path resolution
   (`build-includes.test.ts:495`, `names no relation at 'caller'`). The behaviour isn't new (the derivation already
   used the merged set). The docstring and the ADR-046 / REL-2 revision text now describe it as an edge the manifest
   carries. **Fix:** state the role branch as what it is ("counted so the derivation and the gate agree; REL-1 does
   not emit it yet, CAP-2 seam `build-graph.ts:502`").

9. `repository.ejs.t:38-39` — `_EU` (`entityName.toUpperCase().replace(…)`) and `_eLower`
   (`E.charAt(0).toLowerCase() + …`) build names and change case inside a template. This is known: it is deferred
   to an RFC follow-up (earlier review round 2, item 5). Two points the deferral misses. First, the
   `no-name-derivation` lint cannot see either spelling (it matches only `.charAt(0).toUpperCase()`), so the allowlist
   that names every remaining site doesn't name these. Second, the deferral's reason ("changes bytes") doesn't hold:
   deriving the same strings in `src/derived/api/names.ts` changes no byte, and `includesConstName` there already
   owns an UPPER_SNAKE rule that `_EU` restates. **DECISION:** whether to widen the lint's patterns now
   (`.charAt(0).toLowerCase()`, `.toUpperCase().replace(`), which would surface these two sites, plus anything else
   that matches, as allowlist entries.

10. `repository.ejs.t:473`, `:493` — `with: { ...opts?.with, <relKey>: true as const }` replaces whatever the caller
    put under the base key. `W extends <E>Include` still admits it (`findWithBase(id, { with: { communication: {
    columns: … } } })`), so the caller's narrower base spec is dropped silently, and the `<E>Flat` type intersects it
    with `true`. **Fix:** constrain `W` to `Omit<<E>Include, '<relKey>'>`, or put the base key first so a caller's
    spec wins.

11. `repository.ejs.t:254-256` — every child gets the comment "its row is in scope only while its base row is
    (`baseScope`)", including a tenant-only child like `MeetingRepository`, whose `behaviors` has no `baseScope` key.
    **Fix:** print the `baseScope` clause only under `_child.baseScope`.

### Checked and fine
- **ADR-046, existence and method names:** every family read is a derived entry with an `origin` (`inherits` /
  `discriminator` + the child kinds named). `FAMILY_METHOD` in `names.ts` owns the method names. Both templates gate
  `_child` / `_base` on `apiSurface.*.methods`, never on `familyChild` / `familyBase`. The service forwards via
  `m.delegatesTo.method`. `matrix-discriminator-no-child` pins "a discriminator with no child has no cross-kind reads
  and no typed include".
- **`hasTypedInclude` as the one owner:** the derivation's `typedInclude`, every read's `readOptions`, and the
  include-allowlist gate all read it. `declaresOwnRelation` is deleted along with every reference to it (code, ADR-046,
  REL-2, PLAN.md). The three new allowlist-gate cases can fail (the "no family" refusal is asserted both present and
  absent).
- **Absent inputs fail loudly:** `entityScope` throws for a child with no base supplied, `buildRelationGraph` throws
  for a base outside the entity set, `familyReads` throws for a discriminator base whose lookup can't enumerate
  (tested via the `Proxy` lookup), and `EntityApiInput.inheritanceChildren` is required. Nit 4 is the one exception.
- **Runtime scope:** `baseScopePredicate` is wired into `scopeFilter`, so the root, every hop (`hopScope`) and
  `scopedRoot` share it from one place. `isUnscoped` / `isUnscopedConfig` both count `baseScope`. Narrowing
  `scopeConfigFor`'s `softDelete` to "apply the guards" (masked per declaration, base included) gives the flag one
  meaning: the by-id write path still matches a soft-deleted base, which is asserted.
- **Root and hop agree for the tenant axis:** the child repository's `tenantScoped` / `tenantColumn` / `strict`
  (`scopeTenantColumn` from `inheritedChild.tenant`) and the manifest's child scope (`resolveChildTenancy`) come from
  the same tenancy resolution. `inheritance-scope-http.test.ts` closes the pre-S3 cross-tenant `GET /meetings`.
- **`optional: false` on child → base:** the documented exception to `hopCanDropTarget` holds, because a child that
  was read has passed its own `baseScope`. `hopCanDropTarget` now counts `baseScope` for edges into a child.
- **`asKind`'s orphan invariant is stated:** R5, plus the composite tenant FK, plus the hop's `EXISTS` re-applying the
  same base predicate. `findOrphans`' `notExists` is unscoped on the child by design and sits under the base's root
  scope.
- **One statement per read** is measured on the generated repositories against Postgres
  (`inheritance-reads.test.ts:305-335`, with a counter control), not only on the hand copy in
  `inheritance-read-sql.spec.ts`.
- **Naming rules hold:** `entityClassName` comes from `names.ts`, table exports and import paths go through
  `moduleRef` / `projectEntityLookup`, nothing is pluralized by hand, and no `globalThis` regression appears in the
  new emitted types. The vendored-runtime list and `runtimeImportLocals` both carry `base-classes/inheritance`.
- **The behaviour-name duplication** between `resolvedBehaviorNames` and `build-graph.ts`'s `behaviorNames` was
  reviewed in round 1 and is documented as deliberate (throwing vs. registered-already). It is not re-reported.
- **Studio's `REPOSITORY_KINDS` / `SERVICE_KINDS`** are `Record`s over the derived unions, so the compiler enforces the
  new kinds.
