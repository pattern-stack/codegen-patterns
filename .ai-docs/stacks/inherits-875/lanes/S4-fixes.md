# S4 review fixes — lane `inh-s4-build`

The Opus review of `dugshub/875-s4-inherits-writes` @ `5f9fd68f` returned **REVISE**: gates green, but the typed
write surface returns `never` and the recorded IBaseRepository measurement is vacuous. Fix on the same branch as new
commits (no history rewrite); COMMON.md still binds you. Re-verify each finding before fixing it. **DECIDED** items
are coordinator decisions — do them as stated.

1. **BLOCKER — `<Child>Flat` with default generics is `never`** (`repository.ejs.t:233`, with `:194`).
   `MeetingNoInclude = globalThis.Record<string, never>`, so `TWith & { communication: true }` gives
   `communication: never`; `IsNever<MeetingFlat>` is true, and `(await repo.create({...})).title`,
   `(await repo.findWithBase(id))?.title` and `(await service.upsertByNaturalKey({})).row.title` are TS2339. The alias
   is S3's; fix it here (the stack lands atomically) — the reviewer's working form strips the index signature:
   `{ [K in keyof TWith as string extends K ? never : K]: TWith[K] } & { communication: true }`; prefer a fix at the
   root (the `NoInclude` / with-type the alias is built from) if that is cleaner, without changing what other reads
   type. **Gate:** in `test/baseline-type-assertions.ts`, an `IsNever` assertion on `MeetingFlat` and real field reads
   off child `create`, `update`, `upsertByNaturalKey(...).row`, `findWithBase` and `findManyWithBase` (and the service
   forwards). Show it red on the current alias. **Then re-do the IBaseRepository measurement honestly** under the
   smoke's consumer tsconfig with the fixed type, and rewrite RFC `:809` and "S4 as built" with what it actually shows
   (if the override no longer satisfies `IBaseRepository`, take the RFC's fallback and say so).
2. **`match:` fill bypassed on two runtime INSERTs** — `integrated-entity-repository.ts:124-131`
   (`integrationUpsertOne`) and `metadata-entity-repository.ts:64-73` (`upsertMany` with `conflictTarget`). S1 accepts
   `match:` on both patterns, so the sink can never write. **DECIDED: fill it**, lifting the brief's fence on those two
   files for exactly this: `values = this.deriveColumns(values, 'create')` and `set = this.deriveColumns(set,
   'update')` at both sites (camelCase keys, which `fillDerivedColumns` reads). Add one test per path (unit or
   integration, whichever the existing tests for those repositories use) that fails without the call. Correct RFC
   `:1463` (it is not S7's).
3. **The upsert bypasses the userTracking scope axis** (`repository.ejs.t:326`, `:849`; charter I3). User A can upsert
   user B's key in the same tenant and overwrite it (and set `userId` to A). **DECIDED:** AND `this.scopePredicate()`
   into the conflict `setWhere`; never SET the user column (add it to UPSERT_NEVER); when no row comes back, classify
   with **one** read of the conflicting row: another kind → `KindMismatchError`, same kind → a scope refusal (use the
   error the scoped `update()` path already throws for this case, do not invent one). Add a plain scaffold entity with
   `user_tracking` + `natural_key` (with item 7's) and an integration case: B's row untouched, the call refused.
4. **Casts** — nine `as unknown as`, not two (`repository.ejs.t:722/750/759/806/860`, `service.ejs.t:210/214/219`,
   `inheritance.ts:202`). With item 1 fixed: `readBeforeUpdate` returns `this.repository.findWithBase(id)` uncast;
   service `create` / `update` need only a checked `as Promise<<Child>Flat>`; child `create` returns
   `flattenBase({ ...childRow, communication: baseRow }, 'communication')` with the insert on the concrete table (one
   owner of flattening — S3's). Count what remains, and make the RFC's number true.
5. **A test that cannot fail** (`inheritance-writes.test.ts:282`, "…when the caller owns the transaction and
   swallows the error"): with the `setWhere` guard deleted it stays green, because the child insert's 23503 aborts the
   transaction anyway. After the swallowed error, write something else in the same transaction and assert it
   committed. Show it red with the guard removed.
6. **A second DI path** (`entity-locals.js:2058 repositoryDepBases`, `module.ejs.t:164-167/:187-189`) — the third
   place encoding "a child repo needs its base repo", contradicting the module's own ADR-002 rule (`module.ejs.t:124`).
   **DECIDED:** delete `repositoryDepBases`; a module that composes another entity's repository gets it by importing
   that entity's **home module** (with `forwardRef` only where a real cycle exists), so the dependency closure is owned
   by the home module. Keep the smoke's Nest DI boot green.
7. **No gate runs a plain `natural_key` entity** (the no-discriminator upsert): add one plain `natural_key` entity
   (tenant-scoped + `soft_delete`, so OQ-14 runs — share it with item 3's if one entity can carry both cleanly, else
   two) to the baseline and scaffold fixtures, with integration cases: insert, update on conflict, a soft-deleted match
   is updated and stays deleted. Note in the RFC (for S6's #780 comment, A16) that the single-row upsert now exists on
   every `natural_key` entity, with OQ-14's semantics.
8. **Child update order** (`repository.ejs.t:732-759`): the child row is written before the base's guards
   (`guardTenantOnUpdate`, M4 on base-derived columns) run, so a swallowed guard error in a caller-owned transaction
   leaves the child half written. Reorder: select the child (scoped), update the base, then update the child. Test the
   swallowed-guard case leaves the child untouched.
9. **Orphan repair reports `created: false`**: a child upsert takes `created` from the base only, so repairing an
   orphan base row emits `meeting.updated` for a meeting that did not exist. Take the child's `created` from the
   child insert (`xmax = 0` on the child statement); base events keep the base flag. Test the orphan-repair case.
   Say so in §4.2.
10. **RFC drift:** the §4.1 table still says `baseRepo.update` "always runs"; make it match the as-built rule.

Gates after your last edit (paste tails): `bun run typecheck`, `just test-unit`, `just test-baseline` (list changed
pre-existing snapshots by category; #680 untouched), `just test-smoke`, `just test-integration`,
`just test-smoke-capability`, `just test-smoke-subsystems`, `just test-smoke-integration` and `just
test-integration-emit` (items 2 and 6 reach them). Report per COMMON.md with a finding → commit / test table and the
honest IBaseRepository result.
