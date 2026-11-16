# S3 review fixes — lane `inh-s3-build`

The Opus review of `dugshub/875-s3-inherits-reads` @ `8e1362e3` returned **REVISE** for one blocker; everything else
is sound and every gate is green. Fix on the same branch as new commits (no history rewrite); COMMON.md still binds
you. Re-verify each finding before fixing it.

1. **BLOCKER — a fields-only child's service does not compile** (`service.ejs.t:126,133`, import at `:34`).
   `findWithBase` / `findManyWithBase` use `<E>Include`, imported only under `if (includes)`, and `includes`
   (`entity-locals.js:1691`) is true only when the entity declares its own `relationships:`. Removing `relationships:`
   from `email.yaml` gives `TS2552: Cannot find name 'EmailInclude'`. That YAML compiled on S2.
   **Gate:** add a fields-only child to the generated fixture sets — `message_communication_part` (child of
   `communication_part`, `as: message`, a field or two, no relationships) in the inheritance, scaffold and smoke
   families (fixture agreement keeps them identical). Show the gate red before the fix.
2. **Fixes 1 — `includes` follows the family** (your deferral to S5 does not hold: the controller / use-case effect is
   type-only). `includes = includableRelations.length > 0 || family.child !== null || (family.base?.children.length ??
   0) > 0`, computed after `familyReads` (no patching of a returned object). Result: a child's plain reads type
   `with: { communication: true }` by design, not by accident, and the base's `findById` / `findByIds` / `list` type
   `with: { meeting: true, email: true }` (RFC §3.3). The reviewer measured the snapshot diff as five base files
   (repository, service, controller, find-by-id and list use cases) with HTTP behaviour unchanged (`?include=` still
   400 — the allowlist is S5's). Add a type-level assertion (in the smoke usage or a baseline-compiled check) that
   `communicationRepo.list({ with: { meeting: true, email: true } })` types, and update the RFC "as built" bullet.
3. **RFC note on `meeting_transcripts.meeting`** (`RFC :1341-1345`): the optional:false → optional:true flip comes
   from the existing tenant clause (an unscoped source hopping into a now-tenant-scoped target), not from
   `baseScope`. Correct it, and record the behaviour change: a `meeting_transcripts → meeting` traversal with no
   tenant boundary (a background job) now throws.
4. **Dead branch** (`build-graph.ts:358-362`, RFC `:1349`): "base not in the entity set → warning, edge skipped"
   cannot run, because `entityScopes` → `scopeOf` throws first. Keep the error, delete the branch, make the RFC say
   one thing.
5. **`softDelete: false` means two things** (`base-repository.ts:560`). Make reads pass `softDelete: true` ("apply
   lifecycle guards") and let `scopeConfigFor` mask it with `behaviors.softDelete` and `base.softDelete`, so a
   hand-written `{ softDelete: false }` that wants deleted rows gets them on the child too. Test that case. This is
   under `runtime/base-classes/`: run the smokes.
6. **Third behaviour derivation** (`entity-locals.js:2194-2199` `familyBaseBehaviors`): extract one
   `resolvedBehaviorNames(def)` in entity-locals and use it for the entity's own behaviours (`:1931`) and its base.
   If build-graph's `behaviorNames` can use the same function without a template→src import problem, use it there
   too; otherwise say why not.
7. **A9 on a hand copy** (`inheritance-read-sql.spec.ts:169-201`): keep the spec, and also tie the one-statement
   claim to the **generated** code — count statements issued by the generated `findAllKinds` / `findOrphans` /
   `findWithBase` in `inheritance-reads.test.ts` (wrap the client / use a query logger). Show it red by making one
   generated read issue two queries in a scratch copy, or by reasoning if that is impractical — say which.
8. **asKind comment:** one line at `asKind` stating that "null child ⇒ orphan" holds because R5 bars child-own
   lifecycle axes and the child's tenant column is pinned to the base's (so a base row visible at the root always
   has its child visible at the hop).

Gates after your last edit (paste tails): `bun run typecheck`, `just test-unit`, `just test-baseline` (list changed
pre-existing snapshots by category), `just test-smoke`, `just test-integration`, `just test-smoke-relationship`,
`just test-smoke-junction`, `just test-smoke-frontend`. Report per COMMON.md with a finding → commit / test table.
