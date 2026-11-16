# Lane `s7c-build` — S7c: the integration layer has no opinion on `inherits:`

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/integrated-child-917/lanes/COMMON.md` first; it binds you.
Then read RFC-0006 §4.2 and §13.2 (S7, S7a), issue #917, and the integration RFCs: `docs/rfcs/RFC-0001*`, `RFC-0002*`
and `RFC-0003*`. Also read CLAUDE.md's "Integration Codegen" section.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-917-s7c-integrated-emitter`
- **Branch:** `dugshub/917-s7c-integrated-emitter`, on S7a (`53471b30`).
  - S7b (the child's repository adapter) is being built **in parallel** on its own branch. Your branch will be rebased
    onto S7b afterwards, so touch only the integration emitters and their tests, never the backend entity templates or
    `runtime/base-classes`.
  - If you need something from the repository side, write it down and report it; do not build it.

## The rule this slice enforces

**A provider sync has no opinion on an entity's family hierarchy.** Whether the target entity is a joined-table child
must not change:
- the integration YAML;
- the adapter scaffold;
- the sink (`<entity>.sink.generated.ts` and the emit-once `<entity>.sink.ts`);
- `changeSources`;
- the read primitive (`IncrementalReadBase`);
- module assembly (`<entity>-integration.module.ts`, tokens, the surface aggregator).

The emitters are `src/cli/shared/sink-emission-generator.ts`, `assembly-emission-generator.ts`,
`adapter-emission-generator.ts`, `change-emitter-emission-generator.ts` and `integration-scaffold-locals.ts`. The gate
lives in `test/integration-emit/`.

## What to build

1. **The family-blind gate.** Add a test in `test/integration-emit/`.
   - Render the integration layer for one entity twice, from two fixture projects:
     - **A:** `mail_message` as a **plain** `pattern: Integrated` entity whose fields are the child's flat shape (the
       base's declared fields plus the child's own, without `kind` / `inherits:`);
     - **B:** the S7a family (`test/fixtures/integrated-child/entities/`), where `mail_message` is a child of
       `inbox_item`.
   - Both use the same provider and surface definitions and the same integration YAML.
   - The entity name is the same, so the two outputs must be **byte-identical file for file**: the same file set, the
     same bytes. The test asserts exactly that. It does not filter lines.
2. **Show it can fail.** Before any emitter change, run it and paste the diff. Then:
   - If it is already empty, mutate one emitter to branch on `inherits:`, show red, then restore.
   - If it is not empty, each differing line is a place the emitter reads the entity's **own** YAML where it should
     read the **flat** shape, or branches on the family. Fix the emitter to read the one derivation the backend
     already uses for a child's flat columns (find it: S3/S5 built `flatChild` / the derived surface; never re-derive
     it). If a difference cannot be removed without a design choice, stop and report it as a NEW decision.
3. **The integration-emit snapshot** (`test/integration-emit/__snapshots__/`) gains the family's layer. Re-bless it with
   the repo's flag, and explain the diff. It should be only new files for the family.
4. **The assembly contract** (`assembly-contract.test.ts`): if it enumerates Integrated entities, the two children must
   be covered by it without a family case.
5. **RFC.** S7's §13.2 entry gets an S7c as-built entry, saying what the gate is and what it caught.

## Tests

The gate above (red, then green, with the mutation shown), and the snapshot.

## Gates (after your last edit)

`bun run typecheck`, `just test-unit`, `just test-integration-emit`, `just test-baseline`. Compiling the family's
integration layer against the generated backend needs S7b, so that is S7d's (`test-smoke-integration`), not yours.
Commit as `feat(#917 S7c): …`. Do not push. Report to `codegen-patterns-73`: commits, files, the first diff the gate
showed, every emitter change and why, and what S7d inherits.
