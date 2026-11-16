## Gate 2.5 — Quality (lens=quality) · PR #910 @ edc0467

**Against:** CLAUDE.md + quality canvas + reuse/layering
**Verdict:** REVISE

Reviewed `git diff dugshub/875-s3-inherits-reads...HEAD`. The PR head `edc0467` is a rebase of the worktree tip
`7a11b49`, and the two diffs are byte-identical, so every `path:line` below holds at both. I read the RFC's prose only to
locate things. The three earlier review rounds on the PR were checked at the tip, and nothing they resolved is
re-reported here.

### Blockers

1. `templates/entity/new/backend/entity-locals.js:816` (`moduleGraphEdges`), `:1968` (`reaches`), `:2145`
   (`forwardRef: reaches(...)`). **Defect:** the cycle check runs over a graph that is not the module graph. It counts
   `belongs_to`, `has_many` and `inherits` edges. Two kinds of module import that this module file also prints are
   missing from it:
   - junction fan-out: a parent imports the junction's module, and the junction's module imports both parents
     (`templates/junction/new/module.ejs.t:11-12, 26-27`);
   - the EAV block's `<Definition>sModule` import.

   Before this PR, a composing module provided the target's repository itself and imported no module. Now it imports
   the target's home module, so these edges can close an ES-module cycle that `reaches` cannot see. The import is then
   printed without `forwardRef`. The doc comment's "a superset of what one render composes" does not hold.
   **Scenario:** `contact` has a `belongs_to account` and `account` declares no `has_many: contacts`. A junction
   `account_contact` has `between: [account, contact]`.
   - `contacts.module.ts` prints a plain `AccountsModule`, because `reaches(account, contact)` is false.
   - `accounts.module.ts` imports `AccountContactsModule`, which imports `ContactsModule`.
   - The generated `modules.ts` barrel is sorted by name, so `accounts.module` is evaluated first:
     accounts → account-contacts → contacts → accounts (still half-evaluated).
   - `ContactsModule`'s `@Module({ imports: [...] })` evaluates while `AccountsModule` is still `undefined`.
   - Nest refuses to boot: "the module at index [1] of the ContactsModule imports array is undefined".

   EAV has the same problem: a `field_definition` that declares `has_many` onto its value table gets `forwardRef` on
   its own side only, while the value table's EAV-block import of `FieldDefinitionsModule` stays plain. Whether it
   boots then depends on load order. No fixture has either shape. The junction smoke's `contact` → `account` edge has
   no path back to `contact`, so nothing in CI can catch this.
   **Fix:** there are two ways.
   - Simplest: print `forwardRef(() => X)` on every cross-entity module import, and delete `moduleGraphEdges` and
     `reaches`. The code's own comment says `forwardRef` on a non-cycle changes nothing at runtime. This removes the
     second copy of "which modules does X import" entirely.
   - Or: build the graph from the one owner of module imports (`repositoryDepModules` + `junctionFanOut` + the EAV
     imports), computed for every entity in the set.

   Either way, add a boot fixture with a junction between a `belongs_to` pair.

### Should-fix

1. `templates/entity/new/backend/repository.ejs.t:59-65` (`_ormAlready`) against `:88-97`. **Defect:** "which
   `drizzle-orm` names are already imported" now has three owners:
   - the first import line's conditions;
   - `_familyOrm`'s filter, which `_ormAlready` copies verbatim at `:64`;
   - `_ormAlready` itself.

   It prints four `import … from 'drizzle-orm'` statements (the generated `communication.repository.ts:4-6` has three).
   This PR fixed the same shape for module imports ("one owner for module imports") but not for this one.
   **Scenario:** add `and` to line 88 under a new condition and forget `_ormAlready`. Every repository that also
   prints a guarded upsert then fails with TS2300 (duplicate `and`). **Fix:** build one `_orm` set in the prelude
   and print one import line. (`canvas: magic_constants`, second copy of a rule.)

2. Repository `pair_create` / `pair_update` / `pair_delete` / `kind_guard` / `upsert_*` bodies
   (`repository.ejs.t:735, 771, 809, 821, 839`, …) and the matching service bodies (`service.ejs.t:265, 270, 286-287,
   295, 307-309`). **Defect:** each signature prints the derived parameter names (`m.params[i].name`), but the body
   hard-codes `input` / `patch` / `id` / `tx`. The same template's pre-existing bodies print `m.params[i].name`
   (`:506, :525, :547-553, :566, :1023-1027`). So the name has two owners, and the derivation only appears to own it
   (ADR-046 "templates print"). **Scenario:** rename `patch` to `input` in `src/derived/api/entity.ts:447/584`, for
   example to match `BaseRepository.update`. Every child repository and service then prints `update(id, input, tx)`
   with `splitByOwner(patch, …)` in the body, which is TS2304. **Fix:** print the parameter names in the bodies, as
   the read bodies do.

3. `templates/entity/new/backend/entity-locals.js:2991` (`familyConstPrefix`). **Defect:** exported generated names
   (`MEETING_BASE_KEYS` is `export const` and is imported across files by the service; `<EU>_NATURAL_KEY`,
   `<EU>_CHILD_CREATE_PATH`, …) are cased by an inline `toUpperCase().replace(...)` in the backend locals.
   CLAUDE.md / ADR-046 says a generated name is derived once in `src/derived/api/`. The analogous exported constant
   already lives there (`includesConstName`, `names.ts:232`), with a different casing rule, so the project now has
   two SCREAMING_CASE rules. The R2 fix moved this derivation out of the two templates but stopped at the locals.
   **Scenario:** a camelCase or prefixed entity name. `includesConstName` splits `dealStates` into `DEAL_STATES`, while
   this rule gives `DEALSTATES`, so the two constants of one entity are cased differently. **Fix:**
   `familyConstName(entityName, suffix)` in `names.ts`, read by both templates through the locals.

4. **DECISION** — where the "a kind with a child table is written only with its child row" invariant lives.
   - `KindImmutableError` is the repository's (`repository.ejs.t:820-823`).
   - `KindRequiresChildError` is the service's only (`service.ejs.t:286, 307`).

   So the base repository's public `create`, inherited `upsertMany` and `upsertByNaturalKey` accept `kind: 'meeting'`
   and write an orphan base row. Meanwhile the generated `findOrphans` doc says "the generated write path never
   produces one" (`repository.ejs.t:700`). This PR makes every module export its repository and share it with
   composing modules, so direct repository callers (a job, a sink, a hand-written use case) are the expected path.
   **Scenario:** `communicationRepository.upsertByNaturalKey({ kind: 'meeting', source, externalId, … })` inserts a
   `communications` row with no `meetings` row, and nothing errors. **Fix**, either:
   - (a) guard in the base repository, with the child's pair write entering through an explicit child-only path
     (e.g. a protected `createAsKind(kind, …)` that the child calls);
   - (b) keep the guard service-only, and correct the `findOrphans` doc and the base repository's doc to say
     repository callers bypass it.

5. **DECISION** — the new write errors reach HTTP as 500s. The base keeps its write routes, and:
   - `POST /communications {kind: 'meeting', …}` throws `KindRequiresChildError`;
   - `PATCH /communications/:id {kind: 'email'}` throws `KindImmutableError`.

   Both are plain `Error`s. There is no exception filter anywhere in `src`, `templates` or `runtime`, so Nest answers
   500 to a client mistake. The controller already maps its own domain error to a 400
   (`controller.ejs.t:111`, `IncludeNotAllowedError`). The DTOs do not help: the base's create DTO allows every kind
   (generated `create-communication.dto.ts:5`, `z.enum(['meeting', 'email', 'message'])`), and update is
   `Create.partial()`. **Fix**, either:
   - derive the base DTOs from the same facts (create: base-only kinds; update: omit the discriminator), so Zod
     answers 400;
   - map the four errors in the controller.

   This may belong to S5's DTO work. That is the decision.

6. `test/fixtures/entities/catalog_entry.yaml:4-5` / `test/scaffold/entities/catalog-entry-scaffold.yaml:4-5`.
   **Defect:** both files say "Keep field-identical … (src/__tests__/fixtures/inheritance-fixtures-agree.test.ts)".
   That test only compares the entity names it finds under `test/fixtures/inheritance/entities/`
   (`inheritance-fixtures-agree.test.ts:67`), and `catalog_entry` is not there. The cited gate cannot fail on this
   subject (CLAUDE.md: "a gate must be able to fail on its own subject"). **Scenario:** add a field to the baseline
   copy only. The baseline and scaffold now prove the upsert against different entities, and every gate stays green.
   **Fix:** add `catalog_entry` to the set the agreement test compares, or drop the claim from both files.

### Nits

1. `repository.ejs.t:907-925` (the generated `communication.repository.ts:380-388`). For a base without
   `user_tracking`, the "ONE read of the conflicting row says why" SELECT runs, and then both branches throw the
   identical `KindMismatchError`. The read decides nothing, so the comment is false. Emit the read only when
   `_discProp && hasUserTracking`, where it chooses between `KindMismatchError` and `OutOfScopeWriteError`.
2. `module.ejs.t:96-106`. Every non-self `belongs_to` target is now a real import, so the "Cross-domain modules from
   relationships" hint survives only for a self-FK: the module hints at importing itself. The render golden shows
   `// CategorysModule,` inside `CategoriesModule` (hand-pluralised), and the baseline shows `// OrganizationsModule,`
   inside `OrganizationsModule`. Delete the hint block (`_importedEntities` / `_hintRels`). It is dead output, and the
   template decides which hints exist.
3. `entity-locals.js:817-826`. The `try { entityLookup.definitions() } catch { [] }` is a `convenient_fallback`. It
   swallows the strict throw the lookup exists to raise (`entity-naming.mjs:70-83`: a lookup that cannot read a
   document must not answer "nothing relates"), and reads it as "no cycles". It is also dead: `:2152` and `:2155` call
   `entityLookup.definitions()` unguarded in the same function, so the throw comes back anyway. Delete it (moot if
   Blocker 1 deletes `moduleGraphEdges`). The same guarded expression is evaluated three times; compute it once.
4. `runtime/base-classes/inheritance.ts:227` (`upsertSet(…, never = new Set())`) and `base-service.ts:248`
   (`emitUpserted(…, baseCreated = created)`). An absent input defaults to the permissive answer. The child call
   site relies on `splitByOwner` having removed the base keys already. Make both parameters required, and pass them
   explicitly at the generated call sites.
5. Each helper is gated on something other than its reader:
   - `service.ejs.t:92-99` prints `<EU>_CHILD_CREATE_PATH` under `_base` (a read kind), but it is read under
     `_guardCreate` (a write kind);
   - `repository.ejs.t` injects `baseRepo` and prints `<E>Create` / `<EU>_BASE_KEYS` under `_child` (`with_base`), but
     the pair kinds read them.

   The conditions agree today. Gate each helper on its reader so the two cannot drift.
6. Stale living docs:
   - `entity-locals.js:844-845` (`collectRepositoryDeps`) still says "`module.ejs.t` imports + provides each once";
   - the `inheritance.ts:11-12` header lists only `splitByOwner` / `inTransaction` / the errors;
   - the module template and `entity-locals.js:1963` cite "ADR-002" for the new rule (a composing module imports the
     target's home module, with `forwardRef` on a cycle), but ADR-002 says nothing of the kind. Record it as a dated
     revision note there (CLAUDE.md: touching an ADR's territory).
7. `test/smoke/run-smoke.ts:957-959`. `assertFamilyWithoutNaturalKey` sits between `assertTenancyColumnEmission` and
   that check's own `log('tenancy column emission OK (#791)')`, and logs nothing itself.
8. `test/smoke/fixtures/parcel.yaml:4` cites `src/derived/api/family-reads.test.ts`. The file is
   `src/__tests__/derived/family-reads.test.ts`.
9. `entity-locals.js:2263`. The natural-key entry is found by matching the provenance label
   `` `unique_indexes[${i}]` ``, which uses a display string as a join key. Carry the index on the entry instead.
   Also, `childTenantProp` (`:2996`) restates the child branch of `scopeTenantColumn` (`:2158`).
10. The `// Inherited from BaseRepository: … create, update, delete …` comment now lists methods the class overrides:
    `create` / `update` / `delete` on every child (generated `meeting.repository.ts:391-392`), and `update` on every
    base. #893's named expectation owns this comment, so leave it here, but note the new case on #893.

### Checked and fine

- Which writes exist is decided once, in `familyWriteSurface` (`src/derived/api/entity.ts`). The templates gate the
  write bodies on the derived kinds (`pair_*`, `kind_guard`, `upsert_own` / `upsert_through_base`), not on `m.name`.
  `inheritanceBase` is required, not defaulted. The `inherited` entries skip names already emitted, so there is no
  duplicate `create` (asserted in `family-reads.test.ts`).
- `naturalKeyIndexOf` and `inheritanceBaseOf` live in `src/schema/inheritance.ts`. The dead
  `ParsedEntity.naturalKey` is gone. `moduleClassName` is in `names.ts` and is used by both class-name sites.
- Emitted TypeScript uses `globalThis.Partial / Omit / Record / ReadonlySet / NonNullable`. Module import paths go
  through `emittedStem`. Cross-entity names come from the lookup (`familyReads` / `moduleRef`). No inject template, and
  no filtered error class or directory carve-out.
- The runtime write helpers are pure, and each has a unit test that can fail: `splitByOwner`, `upsertSet`,
  `inTransaction`, `assertBaseOnlyKind`, `fillDerivedColumns` (create overwrite, update re-derive, M4 refusal,
  `coalesce` order).
- `deriveColumns` is an identity hook on `BaseRepository`. The Integrated and Metadata upserts route both the insert
  values and the conflict `SET` through it, each with a test.
- The scaffold `inheritance-writes.test.ts` asserts row counts on real Postgres: child-insert rollback, joining the
  caller's transaction, a swallowed guard error that still lets a later write commit, tenant isolation of the upsert,
  the user-axis refusal, orphan repair (`created` vs `baseCreated`), and the events under both names.
  `inheritance-scope-http.test.ts` mounts the generated `MeetingsModule`, so the child → base module DI is booted.
- Module imports have one owner, `repositoryDepModules`: base first, deduped against a `belongs_to` onto the base (the
  `crate` → `parcel` smoke fixture). `forwardRef` is printed on both sides of a `belongs_to` / `inherits` cycle
  (`parcel` ↔ `crate`, `person` ↔ `crew`). Its gap is Blocker 1.
- `assertFamilyWithoutNaturalKey` and the `natural_key` DDL test (`inheritance-ddl.test.ts`, exact differing-file
  list) can each fail on their subject.
