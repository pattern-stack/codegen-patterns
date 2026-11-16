# #875 phase R — rebase one slice onto the new `main` and make it ADR-046-compliant

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/inherits-875/lanes/COMMON.md` first; it binds you
(public repo, no sub-agents, stay in your slice, never push / PR / merge, gates after the last edit).

## Why this phase exists

The #875 stack (S1–S6) was built on `main` @ `074cce00`. While it was built, `main` gained ADR-046 — **generated
API names and existence are derived once; templates print them** — plus Studio's API tab and #778's canvas change
(#876, #877, #880, #881, #882, #886, #887). Read, on your rebased branch:

- `docs/adrs/ADR-046-derived-once-templates-print.md` (the rule and its three gates);
- CLAUDE.md § "Templates print (ADR-046)";
- `src/derived/api/types.ts`, `names.ts`, `entity.ts`, `project.ts` (the derivation);
- `src/__tests__/derived/api-surface-parity.test.ts` (parity: derived surface == generated output, both directions,
  over methods, use cases and routes), `api-surface-golden.test.ts` + `test/api-surface-golden/` (provenance, kinds,
  flags, parameter names), and `src/__tests__/templates/no-name-derivation-in-templates.test.ts` +
  `no-name-derivation.allowlist.ts` (the lint — **the allowlist only shrinks**; you may not add an entry).

Doug decided (2026-11-14) that each slice absorbs ADR-046 **in its own branch**, so every PR in the stack is green on
its own.

## Your lane

Your prompt names: the slice, its branch, the branch it now stacks on (`NEW_BASE`), and the commit it used to stack
on (`OLD_BASE`).

1. **Rebase your own branch** onto its new base: `git rebase --onto NEW_BASE OLD_BASE <your branch>`. Resolve every
   conflict by keeping both intents (ADR-046's structure **and** this slice's behaviour). Never rebase or edit any
   other branch.
2. **Make this slice's own additions derived, not inline.** Every generated method, use case, route, class name or
   existence decision **this slice introduced** (see the slice's "as built" note in RFC-0006 §13.2 and
   `git diff NEW_BASE...HEAD -- templates/`) becomes an entry in `src/derived/api/` — a kind in `types.ts` where an
   existing kind does not fit, the name rule in `names.ts`, the existence in `entity.ts` (or `project.ts` when it
   needs the graph — e.g. family membership, a base's children, `match:` referrers; read REL-1's graph or the
   whole-set inputs, never a second walk of the YAML), with an `origin` that points at the YAML that caused it (the
   child's `inherits:`, the base's `discriminator:`, the `unique_indexes` entry with `natural_key: true`, the
   `match:` on a relationship). Templates then **print** those entries — no inline name building, no case change, no
   existence decision in EJS or in `entity-locals.js` for what you moved. Where this slice computed a fact in
   `entity-locals.js` / `templates/_shared/inheritance.mjs` / `src/schema/inheritance.ts` that ADR-046 says belongs
   in the derivation, move it there and have the old site read it (one owner).
3. **Keep the slice's behaviour byte-identical** except for what ADR-046 forces: the generated baseline, smoke and
   integration output should not change because of this phase. If a byte does change, say why in the report.
4. **Golden:** add/update `test/api-surface-golden/` entries for this slice's entities and methods (the golden test
   says which); every change must be explained by this slice. Extend the parity render matrix
   (`src/__tests__/derived/_render-matrix.ts`) if this slice adds a shape the baseline lacks.
5. **Studio's API tab** reads the derived surface: after your change, check (via its tests or `GET /api/surface` in
   the Studio server tests) that this slice's methods show up with their provenance; add a test if none covers it.
6. **RFC-0006:** add a short "ADR-046 (phase R)" line to your slice's as-built note saying what moved into
   `src/derived/api/`.

## Gates (after your last edit; paste tails)

`bun run typecheck`; `just test-unit` (includes the three ADR-046 gates — all green, allowlist not grown);
`just test-baseline`; **the whole `just test-all`**; `just test-integration` when your slice is S2 or later.

## Report

Per COMMON.md: the rebase (conflicts and how you resolved each), what moved into `src/derived/api/` (kind, name rule,
existence, origin), golden changes, any byte change in generated output and why, and the gate tails. Commit on your
branch in logical commits (the rebase itself rewrites your branch — that is expected for this phase only).
