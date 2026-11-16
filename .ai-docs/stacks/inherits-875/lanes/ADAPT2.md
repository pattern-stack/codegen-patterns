# #875 phase R2 — rebase one slice onto ADR-046 Phase B and print from the derivation

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/inherits-875/lanes/COMMON.md` first; it binds you.
Then read `lanes/ADAPT.md` (phase R, already done for your slice): this phase finishes the same job.

## Why

Phase R adapted each slice to ADR-046 **Phase A** (the derivation, parity, golden, lint). While it ran, `main` landed
**Phase B** (#888 B1, #895 B2, #896 B3, #897 B4, #898 B5): `repository.ejs.t`, `service.ejs.t`, the controller,
search controller, module, index and use cases now **print from `apiSurface`** — one loop over
`apiSurface.repository.methods` / `apiSurface.service.methods` with an if/else on `m.kind`, routes read from
`apiSurface.http.routes`, type text from keyed locals (`queryTypes`, `relationTypes`) — and B5 **deleted the locals the
derivation replaced**. B1 added **byte goldens over the render matrix** (`test/render-golden/**`). Read, on your
rebased branch: `.ai-docs/stacks/api-surface-model/PLAN.md` §5 (each template's "As built (B2/B3/B4/B5)" note), the
templates themselves, `docs/adrs/ADR-046-derived-once-templates-print.md`, and the render-golden test.

Doug decided (2026-11-14) that each slice absorbs ADR-046 in its own branch, so every PR is green on its own.

## Your lane

Your prompt names the slice, its branch, `NEW_BASE` and `OLD_BASE`.

1. **Rebase** your own branch: `git rebase --onto NEW_BASE OLD_BASE <branch>`. Expect real conflicts wherever this
   slice edited a template or `entity-locals.js` that Phase B rewrote. Resolve to **Phase B's structure carrying this
   slice's behaviour**. The stack lands with `gh stack merge --squash`, so only your branch **tip** must be green — intermediate commits
   never reach `main`; do not spend time on per-commit render checks or history surgery (coordinator, 2026-11-14).
2. **Print, don't decide.** This slice's methods (already in `src/derived/api/` from phase R) are emitted through
   Phase B's loops: a branch on their `m.kind` (`with_base`, `across_kinds`, `orphans`, `pair_write`, `upsert`,
   `kind_guard`, …) in the repository / service loop, their routes from `apiSurface.http.routes`, their use cases from
   the derived use-case list. Delete every **flag local** this slice added that the derivation now makes redundant
   (e.g. `familyReadsWithBase`, `familyReadsAcrossKinds`, `familyPairWrite`, `familyUpsert`, `familyKindGuard*`,
   `generateCreate` / `generateWrites` if Phase B already prints from use cases/routes) — the template reads the
   surface instead. Bodies, SQL and TypeScript type text stay where Phase B keeps them (a keyed type local is fine).
   **The no-name-derivation allowlist only shrinks**, and must not gain an entry.
3. **Bytes:** generated output stays byte-identical to the slice's phase-R output, except where Phase B itself changed
   bytes for every entity (say which). `test/render-golden/**`: add or re-bless only what this slice's matrix cases
   need, and explain each.
4. **RFC-0006:** one "ADR-046 Phase B (phase R2)" line in the slice's as-built note.

## Gates (after your last edit; paste tails)

`bun run typecheck`; `just test-unit` (parity, golden, lint, render-golden green; allowlist not grown);
`just test-baseline`; the whole `just test-all`; `just test-integration` for S2 and later; `just test-studio` for S6.

## Report

Per COMMON.md: conflicts and how each was resolved, the per-commit render check, which flag locals were deleted and
what the template reads instead, any byte change and why, and the gate tails. Never push.
