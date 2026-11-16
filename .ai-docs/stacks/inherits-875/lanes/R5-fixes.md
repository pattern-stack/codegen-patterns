# R5 light-review fixes — lane `inh-r5`

Light review of S5 phase R (8247146d + the resolutions in 26fed20c / 1ed43f2c): ACCEPT_WITH_FIXES. COMMON.md binds
you. **DECIDED** items are coordinator decisions. Add new commits on top (no further history rewrite, except item 3's
message reword).

1. **DECIDED — one `choices_of` resolver.** `discriminatorKindsOf` (`src/schema/inheritance.ts:95-116`) is a third
   resolver beside `resolveEnumField` (`templates/_shared/inheritance.mjs:82-100`) and the parser's `resolveChoices`
   (`src/parser/validate-inheritance.ts:114`), and `createDisabledBy` is fed by two of them (`entity-locals.js:2282`
   passes `family.base.kinds`; the derivation passes `discriminatorKindsOf`). Bring S6's design down to S5:
   `enumChoices(field, getDefinition)` in `src/schema/inheritance.ts` (literal choices, or one `choices_of` hop) is
   the one resolver; `resolveEnumField` takes its `choices` from it; `discriminatorKindsOf` becomes
   `enumChoices(def.fields[def.discriminator], …)`; and **if the parser's `resolveChoices` can use it, make it** (say
   why not if it cannot). `entity-locals` passes the same list the derivation reads. (S6 already has an `enumChoices`
   — its phase R will collapse onto yours; name and shape it the same so that is a deletion.)
2. **DECIDED — one `baseOnlyKinds`.** "kinds minus child kinds" is computed at `inheritance.mjs:393` and again in
   `createDisabledBy` (`kinds.every(withChild.has)`), and `entity-locals.js:2767` restates it for `z.never()`. Put
   `baseOnlyKinds(kinds, childKinds)` in `src/schema/inheritance.ts`; `familyReads` calls it; `createDisabledBy`
   returns `['discriminator']` exactly when it is empty; the `z.never()` choice reads the same value.
3. **History:** keep the commits; **reword 8247146d's message** to say exactly what it holds (the tests, goldens and
   derived listFlat/countFlat entries), and that 26fed20c carries the derivation's design because S4's phase R had put
   the writes decision in `writesDisabledBy`. Do it with an `exec git commit --amend` / `reword` in a rebase limited to
   that commit. Then re-check each commit renders (typecheck + baseline), as before.
4. **DECIDED — add `'with'` to `ReadOptionsShape`** (types.ts) with its Studio label (`surface-kinds.ts`), and derive
   `listFlat` as `'with'` — its signature takes `opts?: { with?: W }` and no columns. Update the golden and
   `family-reads.test.ts`.
5. The child's `List<Plural>UseCase.calls` lists `service.list` only; its default path calls `listFlat` / `countFlat`.
   Make `calls` say what the use case calls (both paths), so Studio shows the edge.
6. RFC sentence (S5 as built): `createDisabledBy` counts any child as covering its kind; a child with
   `generate.writes: false` or `api: false` leaves that kind with no HTTP create path at all (and
   `KindRequiresChildError` names a route that does not exist). Record it as a known v1 edge.
7. `createDisabledBy`: test `kinds == null`, so a JS caller that omits the key gets the named error.

Gates after your last edit (paste tails): `bun run typecheck`, `just test-unit`, `just test-baseline`,
`just test-studio`. Report to `codegen-patterns-73`, then stop.
