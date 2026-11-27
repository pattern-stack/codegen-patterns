# Lane `fu-globalthis` — every lib global in value position in the emitted backend is `globalThis.<Name>`

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/followups-875/lanes/COMMON.md` first; it binds you.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-fix-backend-globalthis`
- **Branch:** `dugshub/fix-backend-globalthis`, off `origin/main` (`800f4150`).

## The problem

`test/_emitted-name-hygiene.ts` (#813) has two rules: no unqualified lib global **type** where an entity type can be in
scope (except `Promise` / `Array` / `Date`), and no plural-shaped binding in a function that reads a table export. It
also has an opt-in **value-position** rule, `emittedNameViolations(files, { values: true })`. D15 turned that on for the
whole emitted **frontend** tree. The backend tree is still checked with `values: false`. So an entity named `map`,
`set` or `error` (whose type `Map` / `Set` / `Error` is in scope) shadows the lib global in `new Map()`, `new Set()`,
`throw new Error(…)`, `Array.from`-style calls on other globals, and so on.

Known hits in the emitted backend (from the #875 build; confirm each, and find the rest):
- `opportunity-integration-source.module.ts` (`Map`, `Error`)
- `catalog-entry.repository.ts`, `email.repository.ts` (two sites), `meeting.repository.ts` (two sites),
  `communication.repository.ts` (`Set`)
- the EAV matrix case `field_value/service.ts` (`Map`)
- other branch-matrix cases: plural options, `eav_value_table`, integration surface with detection, the two-field select
  query, the capability forwarder.

## Fix

1. **Templates.** In every backend template (`templates/entity/new/backend/**`, `templates/_shared/**`, the relationship /
   junction templates, and any other template or TS emitter whose output lands in the generated backend, including the
   integration emitter under `src/emitters/integration/`), qualify every lib global used in value position as
   `globalThis.<Name>`: `new globalThis.Map()`, `new globalThis.Set()`, `throw new globalThis.Error(…)`,
   `globalThis.Object.…`, `globalThis.JSON.…`, and so on. Keep the existing exception: `Promise`, `Array` and `Date` stay
   bare (validation reserves them as entity names, `src/schema/reserved-entity-names.ts`). Do not change anything else.
2. **Gate.** In `src/__tests__/templates/emitted-name-hygiene.test.ts`, the committed-trees row for
   `test/baseline/packages/api/src` becomes `values: true`, and every backend branch-matrix render is checked with
   `{ values: true }`, so the rule covers the **whole** generated backend with no directory scope and no opt-out. If any
   other test renders backend output (integration emit goldens, junction snapshots), run the rule over those trees too.
   If the helper's value rule misses a shape the brief names (`new X()`, `X.from(…)`, `X.method(…)`, `throw new X(…)`),
   extend `test/_emitted-name-hygiene.ts` and add a helper-level test for that shape.
3. **Show it can fail on its subject.** Before you fix the templates, run the widened gate and paste the red listing.
   After the fix, revert **one** qualified site in one template, regenerate, show the gate red naming that file and line,
   then restore it and show green. Paste both.
4. **Regenerate** the baselines and every backend golden / snapshot with the repo's own update flags. The diff must be
   only `globalThis.` insertions; say so, with a count (`git diff --stat` plus a grep that shows no other change).
5. **Docs.** If the rule's wording changes, update the naming bullet in `CLAUDE.md` ("Emitted TypeScript names lib globals
   as `globalThis.<Name>`") so it says types **and values**, backend and frontend. Update the helper's header comment.

## Gates (after your last edit)

`bun run typecheck`, `just test-unit`, `just test-baseline`, `just test-junction`, `just test-integration-emit`,
`just test-smoke`. Commit on the branch (`fix: qualify lib globals in value position in the emitted backend`), do not
push. Report to `codegen-patterns-73`.
