# Lane `s7b-build` — S7b: an Integrated child's repository writes and reads through its base

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/integrated-child-917/lanes/COMMON.md` first; it binds you,
including D1–D5 and their consequences. Then read RFC-0006 §4.2 (the whole section), §3.2, §5, §13.2 (the S3, S4 and
S7 / S7a entries) and issue #917.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-917-s7b-integrated-repository`
- **Branch:** `dugshub/917-s7b-integrated-repository`, on S7a (`53471b30`). S7a is under review, so its fixes will be
  cascaded under you later. Build on it as it is.

S7a (`53471b30`) made the schema accept `pattern: Integrated` on a child, added the D1 / R5 / R6 / R11 rules, and added
the fixture family `test/fixtures/integrated-child/entities/`: the base `inbox_item` with kinds `mail_message` /
`calendar_event` / `note`, and two Integrated children. Read its commit and its RFC as-built entry. **Its hand-off to
you:**
- emission must not put `external_id` / `provider` / `provider_metadata` on the **child** table.
  `resolvedBehaviorNames` still returns `external_id_tracking` for an Integrated child, so the child's column derivation
  must skip any behaviour the declared patterns list in `readsThroughBase`;
- the base's natural-key entry adopts `external_id_tracking`'s unique constraint: one constraint, not two;
- `upsertByNaturalKey` gets the runtime NULL guard;
- forward the child's reads to the base;
- wire the fixture into an emitting set.

## What to build (the repository, the service and the derived surface)

1. **The child table.** No `external_id_tracking` columns on an Integrated child. Its flat type (`<Child>Flat` /
   `WithBase`) still carries them from the base, as every base column is carried.
2. **One constraint on the base.**
   - The `natural_key: true` entry on `[provider, external_id]` and `external_id_tracking`'s
     `uq_<table>[_tenant]_provider_external_id` are **one** constraint: emit it once.
   - `upsertByNaturalKey`'s conflict target and `integrationUpsertOne`'s are then the same columns.
   - The natural-key reader is `naturalKeyIndexOf` (`src/schema/inheritance.ts`). Do not add a second reader.
3. **The NULL guard.**
   - `upsertByNaturalKey` (base and child) throws a named domain error when any natural-key value in the input is null
     or undefined, before any statement runs.
   - Put it in the one place the upsert lives (the runtime base class or the template, wherever S4 put it), not in each
     caller.
   - Test it on a direct repository call.
4. **`integrationUpsertOne` on an Integrated child** is a thin adapter:
   - resolve the FKs (`fkResolvers`, as `IntegratedEntityRepository` does);
   - call the pair `upsertByNaturalKey`, so S4's kind guard (`KindMismatchError`), the `match:` fill and the
     orphan-repair behaviour come for free;
   - return the projection the sink expects, read from the flat row, plus `created`.
   It must keep `IntegratedEntityRepository`'s contract (`runtime/base-classes/integrated-entity-repository.ts`), so the
   sink cannot tell a child from a plain entity. Read that class first. Decide whether the child repository extends it,
   composes it, or the child template emits the adapter. Choose by what keeps one owner per behaviour, and say why.
   Projection holds across the pair. EAV is not reachable (R9, D5): assert that, do not build it.
5. **Reads and the tombstone forward to the base, scoped to the child's kind:**
   - `findByExternalId`, `findManyByExternalIds` and `findByExternalIdProjected` match the base on
     `(tenant, provider, external_id)` **and** the child's kind, and return the flat child;
   - `softDeleteByExternalId` acts on the base row (D4: soft-delete with `soft_delete`, else null
     `provider` / `external_id`) only when that row's kind is this child's.
   - A tombstone from one child's sync must never touch another kind's row. Test that case: an id held by
     `calendar_event`, tombstoned through `mail_message`.
6. **Events.** A write emits under both names, `created` / `updated` from `created` and `baseCreated`, as S4's
   `upsertByNaturalKey` does through the service. Check that the sink-facing path goes through it.
7. **The derived API surface (ADR-046).** Every method you add, change or forward is an entry in `src/derived/api/`,
   with its YAML provenance. A template prints it and never decides it. The parity gate (`api-surface-parity.test.ts`)
   and the golden (`test/api-surface-golden/`) must pass with the new entries, re-blessed with the repo's own flag.
8. **Wire the fixture** into the **baseline** set (`test/fixtures/entities/` and its config), so the family is emitted
   and typechecked by `just test-baseline`. If the baseline config has no provider definitions for the family's
   surfaces, add generic ones as the existing integration fixtures do. Re-bless the baseline. Every new baseline file is
   the family's; explain any other diff.

**Not yours:** the sink, `changeSources`, the read primitive and module assembly (S7c: they must stay family-blind),
and the Docker integration-tier test (S7d). If the baseline's integration post-step emits the family's integration
layer and it does not compile because of something only S7c owns, stop and report it.

## Tests (each red without its change, then green)

- Unit / render: the child's `entity.ts` has no `external_id_tracking` columns; the base emits exactly one
  `(tenant, provider, external_id)` unique constraint; the NULL guard throws its named error; the child's
  `integrationUpsertOne` delegates to `upsertByNaturalKey` (render text and derived surface).
- `just test-family` or `test/scaffold` (Docker), whichever S4 used for pair writes, covering:
  - create through `integrationUpsertOne`, then update;
  - the same external id under the other child (`KindMismatchError`);
  - the tombstone (and the cross-kind tombstone does nothing);
  - `findByExternalIdProjected`;
  - an orphan base row repaired.
  If the scaffold is the right home, add the family there as a scaffold-only family, as #875's D4 did with `document`.

## Gates (after your last edit)

`bun run typecheck`, `just test-unit`, `just test-baseline`, `just test-junction`, `just test-integration-emit`,
`just test-integration`. Commit as `feat(#917 S7b): …`. Do not push. Report to `codegen-patterns-73`: commits, files,
tests (red, then green), the regenerated diffs explained, the design choice in step 4, and what S7c and S7d inherit.
Stop and report a NEW decision rather than picking one.
