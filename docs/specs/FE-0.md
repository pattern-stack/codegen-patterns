# FE-0 — The emitted frontend tree must compile in a real install, and a gate that proves it

**Status:** Implemented
**Date:** 2026-09-17 · **Implemented:** 2026-09-17
**Issue:** #620 · **Epic:** #580 · **Project:** #578
**Depends on:** REL-1 (#586, branch base only) · **Blocks:** FE-REL (#589)
**Governed by:** `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` (charter I9) · ADR-038 ·
`docs/specs/2026-06-04-frontend-pipeline-rebuild.md` (the version-pairing contract) · `docs/specs/FE-REL.md` §1

## Why

The version-pairing contract (`src/emitters/frontend/deps.ts`) tells a consumer which packages to install. Installing
exactly those, the frontend tree codegen emits **does not compile** — and nothing in this repo would have noticed,
because the emitted frontend tree is type-checked nowhere. `test/frontend-golden` compares bytes and says so in its
own header: the baseline tsconfig "can't resolve `@repo/db/entities` or `@pattern-stack/frontend-patterns` to compile
the output."

FE-REL (#589) is a *typed* client-side join over these collections. It cannot be built on a dependency set that
cannot be typed, so this lands first.

## Measured

All numbers below were taken on this branch, against live npm, with **bun** (the package manager every other smoke
uses) and cross-checked with **npm**. Both reproduce it identically.

### 1. Today's ranges resolve four copies of `@tanstack/db`

`bun install` of exactly `FRONTEND_EMITTED_DEPS`:

```
node_modules/@tanstack/db                                     -> 0.5.33   (via @pattern-stack/frontend-patterns)
node_modules/@tanstack/electric-db-collection/…/@tanstack/db  -> 0.6.1
node_modules/@tanstack/react-db/…/@tanstack/db                -> 0.7.0
node_modules/@tanstack/query-db-collection/…/@tanstack/db     -> 0.9.2
```

Compiling the **real** emitted tree (`test/frontend-golden/snapshot/`, unmodified) against it:

```
gen/collections/person.ts(10,2): error TS2769: No overload matches this call.
gen/collections/user.ts(11,2): error TS2769: No overload matches this call.
```

whose elaboration names two of the copies:

```
The types of 'sync.sync' are incompatible between these types.
  Type '(params: { collection: import(".../@tanstack/electric-db-collection/node_modules/@tanstack/db/…").Collection<…>
    is not assignable to type '(params: { collection: import(".../@tanstack/react-db/node_modules/@tanstack/db/…").Collection<…>
```

This is the frontend analogue of the dual-`drizzle-orm` hazard DRZ-2 fixed by moving it to a peer: one package, one
type identity, or nothing that crosses it can be typed.

### 2. The root cause is caret ranges over packages that pin `@tanstack/db` **exactly**

| package | declares `@tanstack/db` |
|---|---|
| `@tanstack/react-db@0.1.55` → `@0.1.96` | `0.5.11` → `0.7.0` |
| `@tanstack/electric-db-collection@0.2.11` → `@0.2.43` | `0.5.10` → `0.6.1` |
| `@tanstack/query-db-collection@1.0.6` → `@1.2.15` | `0.5.11` → `0.9.2` |
| `@pattern-stack/frontend-patterns@0.2.0-alpha.20` | `^0.5.11` (a **dependency**, not a peer) |

Three exact pins behind three carets. Any drift splits the identity, and drift has already happened — the floors in
`deps.ts` sit on `db@0.5.x` while the carets now resolve to three different newer lines.

### 3. The three release in lockstep, so a consistent set exists

Every `@tanstack/db` version has exactly one matching release of each. On the line the pairing is already on:

| `@tanstack/db` | react-db | electric-db-collection | query-db-collection |
|---|---|---|---|
| **0.5.33** | **0.1.77** | **0.2.41** | **1.0.30** |

`0.5.33` also **satisfies** `@pattern-stack/frontend-patterns`' own `^0.5.11`, and is the copy it resolves to today —
so collapsing onto it forces nothing on the package; it deduplicates onto what the package already ships.

### 4. The pins collapse the tree; the `overrides` entry is belt-and-braces

*(Corrected in review follow-up. This section originally claimed "pinning alone is not enough" because
`frontend-patterns` "bundles" a copy. Re-measured, that is wrong: `frontend-patterns` declares `@tanstack/db@^0.5.11`
as an ordinary dependency — nothing is bundled — and `0.5.33` satisfies it, so both managers dedupe it onto the
pin.)*

With the §3 set pinned exactly, `@tanstack/db` installed as a direct dependency, and `frontend-patterns` resolving to
`0.2.0-alpha.20`, measured on 2026-09-19 against live npm:

| Manager | with `overrides` | without `overrides` |
|---|---|---|
| **bun** | 1 copy (`0.5.33`) | 1 copy (`0.5.33`) |
| **npm** | 1 copy (`0.5.33`) | 1 copy (`0.5.33`) |

So **the pins are what the gate proves**: `just test-smoke-frontend` with the caret ranges restored fails with four
copies; with the override removed and the pins kept it passes with one. No install leg can make the override
load-bearing today, because no published version of anything in the set asks for a second copy.

It is kept anyway, as belt-and-braces:

```jsonc
"overrides": { "@tanstack/db": "$@tanstack/db" }   // resolve every copy to the direct dependency
```

It costs nothing, the `$name` form keeps the version in one place, and it closes the two cases the pins cannot: a
future `frontend-patterns` whose `@tanstack/db` range excludes the pin, and a consumer lockfile still holding a
nested copy from before the pins. Neither is a reason to describe it as required.

### 5. With the fix, the real emitted tree compiles clean

The same unmodified `test/frontend-golden/snapshot/` tree, same tsconfig, against the corrected set: **`tsc --noEmit`
exits 0.**

### 6. One undeclared dependency, latent

The emitted collections import `snakeCamelMapper` from `@electric-sql/client`, which `FRONTEND_EMITTED_DEPS` does
not declare. It resolves today only because `@tanstack/electric-db-collection` depends on it (`^1.5.12`) and it
hoists. Not currently red — an undeclared dependency the emitted code relies on, fixed here because this is the file
that declares them.

## Scope

### 1. `src/emitters/frontend/deps.ts`

- Exact pins for the three TanStack collection packages at the §3 lockstep set, plus `@tanstack/db` itself as a
  direct exact dependency. Exact, not caret, for the same reason DRZ-2 pinned the drizzle prerelease exactly: these
  are versions that must agree with each other, and a caret is what broke the agreement.
- Add `@electric-sql/client` `^1.5.12` (§6) — the range `@tanstack/electric-db-collection@0.2.41` itself declares,
  so no second copy.
- `@pattern-stack/frontend-patterns` stays `^0.2.0-alpha.18`. **Not** bumped to `1.0.0`: that release has no
  `dist/sync` at all — no `createStore`, no `createEntityHooks` — and is not dist-tagged `latest` (measured in
  `FE-REL.md` §2.1).
- `@tanstack/react-query` stays `^5.0.0` — it has no `@tanstack/db` in its tree.
- New export `FRONTEND_DEP_OVERRIDES = { '@tanstack/db': '$@tanstack/db' }`, beside the deps it constrains.

### 2. `src/cli/shared/init-scaffold.ts` — `mergeFrontendDeps`

Two rules, by what the entry is *(the first added in review follow-up)*:

- **The lockstep set is corrected.** The four `@tanstack/db`-bearing packages are split out of
  `FRONTEND_EMITTED_DEPS` as `FRONTEND_LOCKSTEP_DEPS` (spread back in, so the version lives once). An existing entry
  for any of the four that is not the pin — the caret ranges `project init` wrote before FE-0, or one package moved
  without the other three — is rewritten to the pin and reported in a new `corrected` field
  (`<pkg> <old> → <pin>`), which init prints as part of the merge reason. Preserving them verbatim, as the first
  version did, meant a pre-FE-0 project re-running init kept the broken ranges forever. There is no consumer choice
  to protect here: the set is the one the gate proves, and moving it is a codegen change (I7).
- **Everything else only adds what is missing** — other dependencies and `overrides` alike. An existing
  `overrides['@tanstack/db']` is the consumer's choice and is left alone.

`unchanged` stays true only when both maps already have every key *and* the lockstep set matches, so re-running init
on a correct project is still a no-op.

The no-`package.json` notice gains the overrides line, so a consumer who has to do it by hand is told the whole
contract rather than half of it.

### 3. `src/emitters/frontend/emit-index.ts`

The version-pairing comment block in `generated/index.ts` gains the overrides stanza, and says the four pins move
together or not at all. That comment is the only place the contract is visible from inside a consumer's tree.

### 4. The gate — `test/smoke/run-smoke-frontend.ts` + `just test-smoke-frontend`

The honest gate the issue asks for. Mirrors `test/smoke/run-smoke.ts`:

1. fresh tmp project, `bun init`;
2. `bun add` the emitted deps **for real, from npm** — plus `react`, `react-dom`, `@types/react`, `typescript`,
   `zod`. No stubbing, no vendored tarball, no offline mode (I9). The `overrides` stanza is written into
   `package.json` first, by the same `mergeFrontendDeps` the CLI uses, so the gate exercises the emitted contract
   rather than a hand-written copy of it;
3. `codegen project init --yes --with-tsconfig` and `codegen entity new --all` over
   `test/smoke/fixtures-frontend/entities/` with `generate.frontend: true`;
4. the consumer-owned `@repo/db/entities/*` modules are copied from
   `test/smoke/fixtures-frontend/db-entities/` and mapped by a tsconfig path. These are **not stubs of anything
   codegen emits** — `locations.dbEntities` is consumer-owned by contract (no template writes there; ADR-038), so
   supplying them is what a consumer does. They are real Zod schemas matching the fixture YAMLs, and drift between
   them shows up as a `tsc` error, which is the correct failure;
5. `tsc --noEmit`, scoped through `test/smoke/_consumer-errors.ts` **by diagnostic location only** — no message
   filters, no directory carve-outs, no predicate added to that helper (I9, GATE-2);
6. plus a direct assertion that exactly **one** `@tanstack/db` is installed, so a future range change that
   re-splits the tree names itself instead of surfacing as an opaque TS2769.

**Cost, measured:** the install is ~12 s and ~110 packages. That is cheaper than the existing backend smokes, so it
goes in **`just test-all`** and needs no separate CI job or cache. Nothing here is cached beyond what `bun`'s own
global cache already does for every other smoke.

### 5. Fixtures

`test/smoke/fixtures-frontend/` — two entities is enough to exercise both collection branches and the cross-entity
store: one `sync: electric` (the `electricCollectionOptions` path, which is where both errors were) and one
`sync: api` (the `queryCollectionOptions` path), with a `belongs_to` between them so resolvers, lookups and
`<Class>Refs` all emit.

## Out of scope

- Any change to `pattern-stack/frontend-patterns`. Its `@tanstack/*` should become peer dependencies — that is the
  real fix and it belongs in that repo (`FE-REL.md` §2.5 items 1–3, for the owner to file). This PR works around it
  with exact pins (plus a belt-and-braces `overrides` line), and says so.
- Relation accessors — FE-REL (#589).
- Bumping `@pattern-stack/frontend-patterns` to `1.0.0` (§Scope 1).
- `pnpm` / `yarn` override syntax. `overrides` is verified for bun and npm; the notice names the others.

## Found during implementation

1. **`project init` cannot turn the frontend on.** `generate.frontend` is written from what the scanner detected,
   which for a fresh directory is `false`, and there is no `--frontend` flag. The smoke edits the `generate:` block
   in place through the `yaml` parser — appending a second `generate:` key produces a document whose second mapping
   silently loses to the first, which is how the first run of this harness ended up generating the `clean` pipeline
   and emitting no frontend at all. That failure mode is now guarded directly: the smoke asserts the emitter wrote
   `index.ts`, both collections, `store/resolvers.ts` and `store/index.ts` before it type-checks anything, so a gate
   that compiles nothing cannot pass.
2. **The `api`-mode collection has its own mismatch.** The spike measured the `electric` branch
   (`electricCollectionOptions`). With the copy assertion bypassed, `tsc` reports **two** errors, not one — the
   `queryCollectionOptions` branch fails too, on `markError` missing between `query-db-collection`'s `@tanstack/db`
   and `react-db`'s. Both fixture entities are therefore load-bearing; neither is decoration.
3. **`mergeFrontendDeps` must not add an empty `overrides: {}`.** The first version assigned `parsed.overrides`
   unconditionally, so a consumer whose package.json was merely missing a *dependency* also gained an empty
   `overrides` key. Guarded.

## Acceptance — all met

Output from the run made after the last edit.

| Gate | Result |
|---|---|
| `bun run typecheck` / `bun run build` | exit 0 / exit 0 |
| `bun run test` (`just test-unit`) | **3219 pass**, 0 fail (incl. REL-1 follow-up +4, FE-0 follow-up +3) |
| `just test-all` | **exit 0** — now 7 smokes, `smoke-frontend PASS` among them |
| `just test-integration` (Docker) | **exit 0** — 68 pass, 2 skip, 0 fail |

Review-follow-up controls: • `test-smoke-frontend` with `FRONTEND_DEP_OVERRIDES` emptied and the pins kept —
**PASS**, one `@tanstack/db` (0.5.33), which is what §4 rests on. • `mergeFrontendDeps` on a package.json carrying
the pre-FE-0 caret ranges rewrites all four and reports them (unit test).

**The new gate was demonstrated red before it was shown green**, both halves:

- with the pre-fix caret ranges and no overrides, it fails at the copy assertion, printing all four copies
  (`0.5.33` / `0.6.1` / `0.7.0` / `0.9.2`) and why that matters;
- with that assertion temporarily bypassed, `tsc` reports the **2** real errors —
  `apps/frontend/src/generated/collections/{account,contact}.ts` — and `_consumer-errors.ts` keeps both, with their
  elaboration chains naming the two `node_modules/.../@tanstack/db` copies. So the location scoping does not swallow
  the very class of error this gate exists for.

No filters, no carve-outs, no new `any`, and **`test/smoke/_consumer-errors.ts` is unchanged** (`git diff` on it is
empty).

## Risks

| Risk | Response |
|---|---|
| Forcing `frontend-patterns` onto a `@tanstack/db` it did not resolve itself | It did: `0.5.33` is both the version it resolves to today and inside its declared `^0.5.11`. Today the override is a no-op (§4); it would only bite if a future `frontend-patterns` asked for another version |
| `project init` rewrites a consumer's lockstep entries | Deliberate (§Scope 2): any other value is the defect this spec fixes. Each rewrite is named in init's output |
| Exact pins go stale as TanStack releases | Deliberate. Caret drift across packages that pin `@tanstack/db` exactly is the defect. Moving the set forward is a one-line change with a gate that proves it still compiles — which is the thing that did not exist before |
| The smoke installs from live npm and can fail because someone else published | True of every smoke here (they `bun add` live ranges too). With exact pins the only live-range packages left are `@pattern-stack/frontend-patterns`, `@electric-sql/client` and `@tanstack/react-query`. Surfacing that here rather than in a consumer is the point |
| `overrides` is npm/bun syntax | Verified on both. pnpm (`pnpm.overrides`) and yarn (`resolutions`) are named in the notice rather than emitted blind |

## Definition of done (charter §9) — done

1. Gates green, output from the run after the last edit — §Acceptance.
2. This spec corrected to post-implementation truth; `Status: Implemented`.
3. `CLAUDE.md` › Testing lists the new smoke, its cost, and why its consumer fixtures are fixtures rather than stubs;
   the smoke-scoping and CI bullets name it too.
4. `CHANGELOG.md` 0.31.0 carries the fix.
5. Epic #580 body + epic log entry.
