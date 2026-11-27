## Gate 2.5 — Adherence (lens=adherence) · PR #912 @ e6226cbc

**Against:** RFC-0006 §12 (A12–A16) + §13.2 S6 (plan, "as built", phase R, phase R2)
**Verdict:** PASS_WITH_NOTES

Reviewed `git diff dugshub/875-s5-inherits-http...HEAD` in the S6 worktree. The local tip `e6226cbc` is a local rebase
of the PR head `29dcbd5d`; the two PR diffs differ only in index lines and hunk offsets. Every finding below was checked at
the tip, by reading the code and by running the frontend emitter over the fixture sets into a scratch directory. No gates
were run.

### Blockers
None. A12, A13, A14, A15 and A16 are met (evidence under "Checked and fine").

### Should-fix
1. `src/emitters/frontend/emit-graph.ts:213` (with RFC-0006 `:559`, `:599` and `:908-910`) — **the inner join is said to hide
   a child whose base is soft-deleted. It does not.** The `isInnerHop` doc says a child's shape holds rows whose base "left the
   base's shape **or was soft-deleted**", so the inner join makes the child absent. But the generated base collection syncs
   the whole table: `collections/communication-part.ts` has `params: { table: 'communication_parts' }`, with no `where` on
   `deleted_at`. A soft-deleted base row is still on the client, so the inner join still finds it. §3.4 lists the
   soft-deleted case as one of the problems, and the only fix it gives is the inner join. §8 says "Clients read a child
   through its base", as if that settled it.
   **Scenario:** a `communication_part` (`soft_delete`) is soft-deleted. On the backend, `GET /transcript_communication_parts`
   drops its child through the base-lifecycle `EXISTS` (A8). On the client, `useTranscriptCommunicationPartsWithBase()` still
   returns it, and so does `useTranscriptCommunicationPartGraph(id, …)`. Server and client disagree on the same list.
   **Fix:** either (a) correct the comment and RFC §3.4 / §8: the inner join hides a child whose base is *absent from the
   client*, and a soft-deleted base is hidden only if the consumer's shape proxy filters `deleted_at`; or (b) add
   `.where(({ base }) => isNull(base.deletedAt))` to `<plural>WithBase(q)` and the root hop when the base has `soft_delete`.
   **DECISION** on (b): it changes emitted behaviour. (a) is the minimum for this PR.
2. `src/emitters/frontend/emit-api.ts:167`, `:174`, `:177` — **the emitted stubs give a family reason to entities that are not
   in a family.** Since R2, `writeRoutes` also turns off mutations for `generate: { writes: false }` and `api: false`. The
   stub text was still written for the all-kinds base. What the emitter writes today:
   - `api/audit-entry.ts` (`writes: false`): `/** No POST /audit_entries: every kind of audit_entry is created through its child
     (RFC-0006 §4.1). */` and `Error('audit_entry has no create route: create a row of any kind through its child')`.
   - `api/ledger-note.ts` (`api: false`, from the unit test's YAML): the same create text, and `update` / `delete` say
     "ledger_note is generated without writes". That entity *has* writes. It has no HTTP routes.

   **Scenario:** a consumer calls `useDelete()` on a `writes: false` hooks object. That still compiles, the limit CLAUDE.md
   records. The runtime error then points them at a child table that does not exist and at an RFC section that does not
   apply. Generated code must not state a false reason.
   **Fix:** take the reason from the derivation: `surface.createDisabledBy` means "every kind has a child"; otherwise use a
   neutral "No `POST /<plural>` route is generated (see the entity's derived API surface)". The same applies to
   update / delete, keyed on `writes: false` versus `api: false`. Add one assertion per case in `inherits-graph.test.ts`.
3. `src/__tests__/fixtures/inheritance-fixtures-agree.test.ts:51` — **the frontend location is resolved under a tenancy column
   its harness does not use.** `PROJECT_TENANCY_COLUMN.frontend = 'organization_id'`. `run-smoke-frontend.ts:165-178` runs
   `project init` and changes only `generate.frontend`, so that project's `tenancy.column` is the schema default `tenant_id`
   (`codegen-config.schema.ts:404-424`). Only `run-smoke.ts` sets `organization_id`. RFC §13.1 says the test resolves
   `tenant_scoped` "under each location's own tenancy column", and for this location it does not. This is CLAUDE.md's gate
   rule (b): assert through the same configuration as the code under test.
   **Scenario:** someone simplifies a frontend copy to plain `tenant_scoped: true`. That is valid for its harness and resolves
   to `tenant_id`, like the source set. The agreement test resolves it to `organization_id` and reports drift that is not
   there. The copies only pass today because they spell `{ column: tenant_id }` out, which this harness does not need.
   **Fix:** `frontend: 'tenant_id'` (what `project init` gives). Reword the comment and the frontend fixtures' header line
   ("tenant_scoped naming its column where the smoke copies do").

### Nits
1. RFC `:1105-1112` — **A12's parenthetical, and A13–A15's missing evidence.** A12 still cites
   `src/__tests__/emitters/frontend/graph-golden.test.ts`, whose entity set has no family. S6's own note says so, and it
   cannot fail on A12. A13, A14 and A15 are ticked with no *Evidence:* line, unlike A1–A12 and A16.
   **Fix:** drop the stale parenthetical. Add evidence lines: A13 `usage/graph-usage.ts` (the `MeetingWithBase[]` assignment,
   the `hopIsOptional` expect-error) and `run-smoke-frontend.ts`'s inner-join assertions. A14 `legend.test.tsx`,
   `relationship-kinds.test.ts`, `edge-view.test.ts`. A15 the S6 "Gates" bullet's mutation run, and S2's for the kind FK.
2. RFC `:1019-1020` (§10 rows 9–10) — **the summary lists less than was built.** Row 9 says "no create hook for an all-kinds
   base", but `writeRoutes` also removes every mutation for `writes: false` and `api: false`, for any entity. Row 10 leaves
   out `tools/studio/src/graph/spine.ts` and the deleted unique-FK tier (`fkUnique`, `fkColumnUnique`, the parity test).
   **Fix:** one clause each.
3. `CLAUDE.md:128` — **"not a stub that rejects" does not match the code.** The frontend does emit rejecting stubs:
   `api/<e>.ts`'s `create` / `update` / `delete` are `Promise.reject(new globalThis.Error(…))`, typed `never`. For `delete`,
   the `useDelete()` path still reaches that stub at runtime. **Fix:** "typed away (`never`), so it cannot be called; the
   api method that remains only rejects".
4. `src/derived/api/project.ts:173-178` — **"the one spelling" of `<child>.inherits` is not the only one.** REL-1 builds the
   same string itself at `src/emitters/relations/build-graph.ts:356` (``const origin = `${entity.name}.inherits` ``).
   `surfaceOf` relies on the two matching (`edgesByOrigin.get(id)` gives `includeKeys`). Only the three project goldens' `includeKeys` hold
   them together. The RFC says "`inheritsRelationId` … one owner". **Fix:** put `inheritsRelationId` where both can import it
   without a cycle (`src/schema/inheritance.ts`, or next to REL-1's types), and call it at `build-graph.ts:356`. Or soften the
   claim.
5. `src/emitters/frontend/emit-utils.ts:23`, `src/emitters/frontend/emit-fields.ts:324`,
   `test/smoke/fixtures-frontend/usage/graph-usage.ts:124` — **stale "use case" wording.** These still say the frontend reads
   "a create / update / delete use case" or "its derived use cases". The R2 fixes moved `writeRoutes` to
   `apiSurface.http.routes`, the RFC records why, and `writeRoutes`' own doc is correct. **Fix:** say "route".
6. `src/__tests__/emitters/frontend/inherits-graph.test.ts:15-16` — **stale header.** It says the no-create pin is "against the
   backend's own derivation (`familyReads`)". The test uses `buildBackendLocals(…).apiSurface.http.routes`; `familyReads` is a
   read-side helper. **Fix:** name `buildBackendLocals` / `apiSurface.http.routes`.
7. RFC `:1830` — **the "Known, not fixed" note is narrower than the bug.** It says the nested-import loop imports a *branch*
   target's to-one hops. The loop (`emit-graph.ts:263-286`) runs over every relation, to-one included.
   `graph/transcript_communication_part.ts` has no to-many branch, yet imports six collections and six row types it never
   uses (`communicationCollection`, `partyCollection`, …). **Fix:** "a relation target's to-one hops, to-one or to-many".
   Still recorded only.
8. PR #912 body — **stale A16 line.** It says "A16 is ticked once the … comments are posted". The comments are posted
   (2026-11-15 on #780, #786, #787) and `e6226cbc` ticks A16. **Fix:** "Closes A12–A16".

### Checked and fine
- **Scope.** The diff touches nothing under `templates/` or `runtime/` ("must not touch: the backend templates"). Every file
  outside the S6 "Touches" list is accounted for in the as-built / phase R / R2 notes: `emit-api|entities|fields|store|utils|collections`,
  `derived/api/project.ts` + `types.ts`, `serialize-graph.ts`, the Studio server and contract, `_emitted-name-hygiene.ts`, the
  three re-blessed project goldens, `spine.ts` / `schema-adapter.ts`. STUDIO-0 / STUDIO-2 got revision notes.
- **Goldens.** The three re-blessed project goldens change by additions only: `relations: []` becomes `inherits` entries.
  `baseline.json` has no removed line. `test/frontend-graph-golden/snapshot/` is unchanged.
- **A12.** `inherits-graph.test.ts` checks the descriptor's child → base edge (`optional: false`) and both base → child
  edges. It checks edge-for-edge equality with `buildRelationGraph`, and that the marker does not reach the descriptor.
- **A13.** The root query uses `.innerJoin` for the base hop only; the other hops stay `.join` and `| undefined`
  (golden `meeting.ts`, `transcript_communication_part.ts`). `buildWithBaseHelper` emits `<Child>WithBase` (re-exported from
  `api/<child>.ts`), `<plural>WithBase(q)` with `innerJoin` on `id`, and both hooks mapping to `{ ...base, ...row }`. The base gets
  none, and a `sync: api` family gets no accessor. `usage/graph-usage.ts` assigns `useMeetingsWithBase().data` to
  `MeetingWithBase[]`, assigns the base hop to `Communication`, and has the `hopIsOptional` `@ts-expect-error`.
  `run-smoke-frontend.ts` asserts both inner joins by text and has no left-join regex.
- **A14.** `edge-kinds.ts` has an `inherits` row (`{ light: '#be123c', dark: '#fb7185' }`, in `EDGE_KIND_ORDER`), and the
  legend renders from it (`legend.test.tsx`). `relationship-kinds.ts` has an `inherits` descriptor (1:1, option `as`, writes
  the child YAML). `test-studio` runs `bun test src/__tests__` after `tsc`.
- **A15.** A13's gates can fail on their subject. With `isInnerHop` off, the hop type gets `| undefined` (TS2322 on
  `meetingBase`, TS2578 on the expect-error) and the runner's text check fails. With the fragment left-joined, the runner's
  `.innerJoin({ base:` check fails.
- **A16.** CLAUDE.md, `yaml-reference.md`, `SKILL.md` and the RFC are written. The #780, #786 and #787 comments were posted
  2026-11-15. Each names what landed (with stack PRs) and what stays. No host-application names.
- **Phase R2 claims.** `writeRoutes` reads `apiSurface.http.routes` (`create`, `update`, `remove`).
  `inherits-graph.test.ts` pins it against the real `buildBackendLocals` for every entity (2 with no create route), plus an
  `api: false` unit case. `entities/<e>.ts` emits `createEntityHooks<Base, never>`, or `<Child, FlatInput, FlatInput>` for a
  child. `store/index.ts` casts only the entities whose create or update is `never`, and `fields/<e>.ts` capabilities follow
  the routes. The `audit_entry` fixture is gated in usage, runner and unit test.
- **One owner.** S6's own copies of `enumChoices` / `baseOnlyKinds` / `baseHasNoCreateRoute` / `hasCreateRoute` are gone from
  `src/emitters`, `src/studio` and `tools/studio`. `createDisabledBy` is read only through the derived surface. Studio's
  `baseKinds` calls `discriminatorKindsOf`. `<Child>WithBase` is defined once (`api/<child>.ts`) and re-exported from
  `graph/<child>.ts`. It omits the base's own discriminator (the `category` case test).
- **Studio.** `serializeDomainGraph` carries `inherits: { base, as, relationId }`, absent on a base or plain entity
  (`serialize-inherits.test.ts`). `buildEdges` draws one child → base line labelled with `as`, never paired, and it is the spine
  (tier `inherits`, then `cascade`, then `first-declared`). The unique-FK tier, `fkUnique`, `fkColumnUnique` and the parity test
  are deleted; that was DECIDED in the S6 R2 brief, following #891's "delete the inference, no shim". The `/api/relationships`
  inherits write refuses: a base with no discriminator, a kind the base does not list (one hop of `choices_of`), a self-inherit,
  an existing `inherits:`, and a result `validateContent` rejects (the R5 case).
- **Date parsers.** `rowCarriesDates` uses resolved behaviours (declared plus `resolveImpliedBehaviors`) and
  `timestampBehaviorNames()`, which reads the registry, not a hard-coded pair. It drops only
  `timestamptz` / `timestamp` / `date`, and `emit-collections.test.ts` covers the implied-pattern case.
- **Leaf targets.** `ClientGraph.leaves` gives `communication_participant.party` a real `partyCollection` join (tested).
- **Fixtures.** `test/smoke/fixtures-frontend/entities/` has the 13-entity family plus `audit_entry`, with consumer row types
  for each, and the agreement test now covers the location and asserts `sync: electric` before stripping it.
