# Review — S7a (#917): the schema accepts `pattern: Integrated` on a child

- **Branch:** `dugshub/917-s7a-integrated-schema`, range `origin/main..53471b30` (`243e277c..53471b30`, one commit).
- **Reviewer:** `s7a-review`, read-only. Every source mutation made during review was restored; the worktree is clean.

## Verdict: `ACCEPT_WITH_FIXES`

| Severity | Count |
|---|---|
| blocker | 0 |
| should-fix | 3 |
| nit | 5 |
| DECISION | 0 |

The slice does what the brief asks, inside its scope: no emission change (baseline byte-identical), the §8 child refusals
lifted, D2 on a base, D1 cross-entity, R5 split through the one reader, `columnsRead` from the behaviour, R11 widened,
the fixture outside every emitting set, and the RFC entries. The property it chose for "read through the base"
(`readsThroughBase` on the pattern definition, one reader `behaviorsReadThroughBase`) is the right owner. Three things
need fixing before S7b builds on it. #1 is the coordinator's ruling. #2 and #3 are permissive defaults in the new R11 / D1
key logic.

### Coordinator rulings, checked

- **A childless `discriminator:` entity is refused under D2.** That is how it was built (`isBase = def.discriminator !== undefined`,
  `src/schema/inheritance.ts:240`), and the RFC entry says so ("a `discriminator:` entity with no children is refused too"). OK.
- **The D1 key match ignores order.** That is how it was built (`isIntegratedNaturalKey`, `src/schema/inheritance.ts:45-47`).
  Verified: a base keyed `[external_id, provider]` gives 0 errors. OK.
- **When D1 fails, R6 should not add errors on the three read-through columns.** **Not done.** See finding 1.

### Gates (run by the reviewer at `53471b30`)

```
bun run typecheck      → tsc --noEmit -p tsconfig.build.json, exit 0
just test-unit         → 5036 pass, 3 skip, 0 fail (5039 tests, 312 files)
just test-baseline     → ✅ All tests passed!  (byte-identical; S7a emits nothing new)
```

Public-repo name check over the diff and the commit message: no hits. `package.json` / `CHANGELOG.md`: untouched.

### Mutation check (does each test fail without its change?)

Each rule was broken on its own and the three suites were run (`integrated-child`, `inheritance-schema`,
`inheritance-tenancy`, plus `src/__tests__/parser`):

| Mutation | Result |
|---|---|
| drop `readsThroughBase` from `IntegratedPattern` | 13 red |
| drop `columnsRead` from `IntegratedPattern` | 4 red |
| `integratedBaseGaps` always `[]` | 4 red |
| drop D1's behaviour check only | 1 red |
| R6 ignores the read-through set | 3 red |
| R6 accepts the set whatever D1 says | 1 red: the test that encodes the opposite of the ruling (finding 1) |
| drop the D2 block | 8 red |
| R11 exemption ignores `declaresTracking` | 1 red |
| drop the R11 exemption | 5 red |
| R5 counts the implied behaviour again | 12 red |
| `isIntegratedNaturalKey` drops its length check (accepts a superset) | **0 red** (finding 4) |

---

## Findings

### 1. When D1 fails, R6 still adds three errors per Integrated child. `should-fix` · Quality (coordinator ruling)

`src/parser/validate-inheritance.ts:356-366` (the `baseGaps.length > 0 ? [] : …` gate) and
`src/__tests__/parser/integrated-child.test.ts:129-136` (the test asserts the extra errors).

**Failure scenario.** In the fixture family, delete `inbox_item`'s `unique_indexes`. Expected under the ruling: 2 errors
(one D1 per child). Actual: **8**. Each child gets its D1 error plus `R6 — '<child>' declares pattern 'Integrated',
which reads the column 'external_id' | 'provider' | 'provider_metadata', and its base 'inbox_item' owns that column …
declare it on 'inbox_item'`. That R6 advice is wrong: D2 refuses Integrated on the base. The same 8 appear when the key
is on `[title]`. (When the base lacks `external_id_tracking`, the base owns no such columns, so R6 is silent and only D1
fires. That case is fine.)

**Fix.** Always accept the read-through columns in R6, and let D1 alone report a base that falls short: drop the
`baseGaps.length > 0` gate. The mutation row "R6 accepts the set whatever D1 says" is exactly this change: it turns
only that one test red. Invert the test so it asserts the D1 errors and **no** R6 on the three columns. Then fix the
three places that describe the old behaviour:
- the comment at `validate-inheritance.ts:356-357` ("a base that does not still fails on the column AND on D1");
- the doc on `PatternDefinition.readsThroughBase`, `src/patterns/pattern-definition.ts:127` ("both only while the base meets …");
- the RFC S7a entry's R6 bullet ("R6 accepts … while D1 holds").

### 2. R11's exemption applies to each column on any non-child entity, not to the pair on a base. `should-fix` · Adherence + Quality

`src/schema/inheritance.ts:391`
(`if (notNull === undefined && declaresTracking && INTEGRATED_NATURAL_KEY.includes(column)) continue;`).

The brief (§6) says "**On a base**, a `natural_key: true` entry may name the two `external_id_tracking` columns". COMMON
says R11 "accepts exactly the two nullable behaviour columns". The code accepts **either column alone**, on **any entity
that is not a child**. That includes a plain entity with no family.

**Failure scenario (verified).** A standalone `widget` with `behaviors: [timestamps, external_id_tracking]` and
`unique_indexes: [{ fields: [external_id], natural_key: true }]`:
- `origin/main` refuses it (R11: `'external_id' is not a declared field`).
- On this branch, `entity validate --json` gives `valid: true`, exit 0.
- `entity new` then emits `uniqueIndex('widgets_external_id_uniq').on(tCols.externalId)` on a nullable column, next to
  the behaviour's own `uq_widgets_provider_external_id`, plus an `upsertByNaturalKey` whose `ON CONFLICT` target is that
  nullable column.

That is the duplicate-on-NULL hazard R11 exists to stop, and S7b's NULL guard is not there yet. Even with the guard, a
key on `external_id` without `provider` merges rows from two providers that happen to share an external id. External ids
are unique only per provider. S7b's brief scopes the one-constraint adoption to "the base", so it will not cover this
entity.

**Fix.** Exempt the entry only when its fields are exactly the pair (`isIntegratedNaturalKey(entry.fields)`, the
predicate D1 already uses, so the key has one owner), on a base that declares the behaviour (`isBase && declaresTracking`).
Every other case stays the normal R11 error. Update the test at `integrated-child.test.ts` "another nullable column still
fails". It asserts `[provider, thread]` reports `thread` but not `provider`. Under the fix it reports both. If anyone
wants plain (non-family) entities to key on the behaviour columns too, that is a new DECISION (it changes what a user
may write). The brief did not ask for it.

### 3. `INTEGRATED_NATURAL_KEY` fails open if the behaviour renames a field. `should-fix` · Quality

`src/schema/inheritance.ts:35-37`
(`['provider', 'external_id'].filter((n) => externalIdTrackingBehavior.fields.some(…))`).

The comment says "Read from the behavior's own field list, never retyped". The names are in fact retyped, then
*filtered* against the behaviour. A rename does not fail. It silently shrinks the key.

**Failure scenario (verified by mutation, restored).** Rename the behaviour's `provider` field to `source` in
`src/behaviors/external-id-tracking.ts`:
- `INTEGRATED_NATURAL_KEY` becomes `["external_id"]`, and `isIntegratedNaturalKey(['external_id'])` is `true`.
- D1 then accepts a base keyed on `external_id` alone.
- R11 exempts it.
- No test goes red.

This is CLAUDE.md's "an absent input must not default to permissive". The same pair is also retyped a third time in the
behaviour's unique constraint, `templates/entity/new/backend/entity-locals.js:2293` and `:2302`. S7b has to make that
constraint and the natural key **one** constraint.

**Fix.** Give the behaviour definition its identity columns, e.g. `identityFields: ['provider', 'external_id']` on
`externalIdTrackingBehavior`, checked against its `fields`. Read them in `INTEGRATED_NATURAL_KEY`, and in S7b's adopted
constraint. At minimum, throw at module load when a name is missing instead of filtering it out.

### 4. D1's "exactly" half has no test. `nit` · Quality

`src/schema/inheritance.ts:46`. Remove the `fields.length === INTEGRATED_NATURAL_KEY.length` check, so a superset such as
`[provider, external_id, title]` matches, and every test stays green. The code is right today. Add the case:
`inbox_item` keyed `[provider, external_id, title]` (`title` is required, so R11 passes) gives one D1 error per child.

### 5. The read-through exemption covers every pattern on the child, not only the one that declares it. `nit` · Quality

`src/parser/validate-inheritance.ts:362-366, 387`. `readThroughBase` is built from all declared patterns, then checked
against every pattern's `columnsRead`.

**Verified.** `mail_message` with `patterns: [Integrated, Activity]` and `config: { Activity: { occurredAt: provider } }`
gives 0 errors. Activity's base class would read `provider` on the child table, which does not have it. The config is
contrived, but the rule leaks.

**Fix.** Exempt only the reads of a pattern that lists the behaviour in its own `readsThroughBase`
(`definition.readsThroughBase`, inside the loop).

### 6. The R11 "at most one" message talks about Integrated children on any entity. `nit` · Quality

`src/schema/inheritance.ts:364-368`. The added sentence ("an Integrated child's sync upserts its base on [provider,
external_id], so a base with an Integrated child declares that one and no other") is unconditional.

**Verified.** It appears for an entity with no `discriminator:` and no family. A single-file rule cannot know whether
there is an Integrated child. Append the sentence only when `isBase`, or only when one of the entries is the pair.

### 7. RFC text outside the edited entries now contradicts the as-built. `nit` · Adherence

The brief limited the edits to the §8 bullet, the §11.3 sub-table and S7's §13.2 entry, and the builder kept to that.
Three passages are now false:
- §1.2 R11 (line 142): "every column in it is NOT NULL";
- §1.2 R5 (line 136): no word on the implied-by-Integrated exemption;
- §4.2 (line 705): "**`Integrated` on a child** stays refused in this build".

This is for the coordinator, who can have S7a add a dated revision note or have S7b amend them as it lands. CLAUDE.md's
living-docs rule says they should not survive the stack.

### 8. The S7a RFC entry should say the fixture validates but does not generate yet. `nit` · Adherence (hand-off)

`docs/rfcs/RFC-0006-joined-table-inheritance.md:2002` ("S7b inherits"). **Verified:** `entity new --all` on a temp copy of
`test/fixtures/integrated-child/entities/` fails `inbox_item` with:

```
[codegen] 'inbox_item': unique_indexes[0] and external_id_tracking declare the same unique over
(tenant_id, provider, external_id). Declare it once.
```

That is the guard at `templates/entity/new/backend/entity-locals.js:1132`. The same happens for any entity that pairs the
behaviour with that key. So `entity validate` says `valid: true` for a YAML that `entity new` refuses. That is expected
at S7a, because the stack lands atomically and S7b owns the adoption. But the hand-off bullet should name the guard, so
S7b replaces it ("a natural-key entry equal to the behaviour's columns IS that constraint") rather than working around it.

---

## Notes for later slices (not findings)

- **S7c.** `surface:`, `integration:` and `detection:` on a child **without** `pattern: Integrated` now pass with no base
  requirement. D1 is keyed on Integrated only. This is in the brief. It means a surface-only child reaches the read side
  (adapter, `changeSources`), so S7c's "family-blind" proof should cover such a child, or the rule should say why it cannot
  occur.
- **S7b.** `resolvedBehaviorNames` still returns `external_id_tracking` for an Integrated child. The RFC entry names this
  correctly. After fix 3, the adopted constraint should read the behaviour's identity columns, not a fourth copy.
- `declaresExternalIdTracking` casts with `as never` (`src/schema/inheritance.ts:41`). Typing the parameter as
  `readonly BehaviorConfig[]` removes the cast. Cosmetic.
