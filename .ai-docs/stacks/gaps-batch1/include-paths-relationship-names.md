---
issue: pattern-stack/codegen-patterns#742
status: strategy-approved            # gate:auto, so Gate 1 is satisfied by the specifier
stack: gaps-batch1
plan_leaf_key: include-paths-relationship-names
plan: origin/dugshub/gaps-batch1-plan:.ai-docs/stacks/gaps-batch1/plan.yaml   # Gate 0 approved 2026-10-31
base_commit: a8629dfc
branch: dugshub/742-include-path-names
size: S
related:
  - src/emitters/relations/build-includes.ts      # the allowlist compiler; the only reader of api.includes paths
  - src/emitters/relations/types.ts               # camelCase: the one function every manifest key comes from
  - src/emitters/relations/build-graph.ts         # where every key is minted
  - docs/specs/REL-2.md                           # §5.1 / §5.2 / §6.3: the allowlist contract this revises
  - .ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md   # charter §4 invariants, §7 decision log
---

# fix(#742): `api.includes` paths accept the YAML relationship name; a miss lists the keys at that hop

## Goal

A host application wrote its include allowlist the way the rest of the YAML is written:

```yaml
relationships:
  fantasy_teams: { type: has_many, target: fantasy_team, foreign_key: league_id }
api:
  includes:
    find_by_id: { max_depth: 1, paths: [fantasy_teams] }
```

and `entity new --all` failed the whole manifest step (exit 1). Only the manifest's camelCase key `fantasyTeams` is
accepted, and the error neither names that key nor lists the keys that exist.

After this PR:

1. Each path segment may be the YAML relationship name (`fantasy_teams`) or the relation key (`fantasyTeams`). Both
   name the same edge, because every segment goes through the manifest's own `camelCase` before lookup.
2. The compiled allowlist, the emitted `api-includes.ts` map, and therefore the `?include=` wire format stay in
   relation keys. A client sends `?include=fantasyTeams`, which is also the property name in the response.
3. A segment that still names no relation fails with the relation keys available at that hop and, when one is close,
   `Did you mean '<key>'?`.

## What happens today (base `a8629dfc`, measured)

The base emitter was run in a scratch script over #742's repro (`league` + `fantasy_team`, with `fantasy_team`
declaring `home_league: belongs_to league`) and over the relationship smoke's real `test/smoke/fixtures/crm/`
YAMLs:

| Declared paths | Base result |
|---|---|
| `[fantasyTeams]` | OK, compiles to `fantasyTeams` |
| `[fantasy_teams]` | `league.api.includes.find_by_id: 'fantasy_teams' names no relation at 'fantasy_teams' — table 'leagues' has no relation 'fantasy_teams' in the generated manifest.` |
| `[fantasy_teams.home_league]` | the same error, at `'fantasy_teams'` |
| `[fantasy_team]` (a typo) | `… table 'leagues' has no relation 'fantasy_team' in the generated manifest.` No keys listed and no suggestion. |
| `[sponsor_brands]` (a junction-derived edge, junction `league × sponsor_brand`) | `… has no relation 'sponsor_brands' …` |
| crm `account`, `find_by_id.paths` + `parent_account` | `account.api.includes.find_by_id: 'parent_account' names no relation at 'parent_account' — table 'accounts' has no relation 'parent_account' in the generated manifest.` |

The keys on `leagues` in that graph are `fantasyTeams`, `leagueSponsorBrands` and `sponsorBrands`. On `accounts` in
the crm fixture they are `contacts`, `opportunities` and `parentAccount`. The existing tests in
`build-includes.test.ts` (24) and `route-name-parity.test.ts` (7) pass on the base commit.

## Decisions

Settled at Gate 0 (plan `open_questions.include_spelling`, approved with every recommendation):

- **Normalise, do not restrict.** Each segment is passed through `camelCase` from `src/emitters/relations/types.ts:115`
  before lookup. No second spelling rule exists anywhere else. This is not a compatibility alias. Every manifest key is
  `camelCase(<snake source name>)` (`build-graph.ts:184` relationship name; `:253`/`:263` the other side's plural;
  `:276`/`:290` the junction plural; `:303`/`:314` the endpoint entity name), and `camelCase` is idempotent on its own
  output (`camelCase(camelCase(x)) === camelCase(x)`, checked on snake, camel, kebab and trailing-underscore inputs). So
  a key-form segment is unchanged by the same rule that maps the snake form. There is one code path.
- **No ambiguity is possible.** Two relationship names on one table with the same `camelCase` would already be a
  `RelationKeyCollisionError` in `build-graph.ts`, so a normalised segment names at most one edge.
- **The wire stays in keys.** `runtime/http/includes.ts` is not touched. `?include=fantasy_teams` stays a 400,
  because the allowlist map is keyed by relation key.

Made here, because the plan did not settle them (each one is also listed in the return summary):

1. **Errors quote what the author wrote.** Validation walks each *declared* path, so the miss and `api: false`
   messages quote the declared spelling (`'fantasy_team'`) and add the normalised key only where it differs.
   Rendering then runs over the de-duplicated key-form set. Before, validation ran over the sorted implied set, so an
   error for `a.b` could fire on the prefix `a`. Now it fires on the declared path. Every existing assertion still
   holds (they match `names no relation at '<prefix>'` and `traverses '<entity>'`).
2. **Suggestion rule.** Compare the normalised segment and each key at that hop, both lower-cased, by Levenshtein
   distance. Suggest the closest key when `distance <= max(2, floor(max(len_a, len_b) / 3))`. Ties go to the earlier
   key in graph order. Measured: `fantasyTeam→fantasyTeams` (1), `FantasyTeams→fantasyTeams` (0),
   `opportunity→opportunities` (3, limit 4) suggest; `nope→contacts` (7, limit 2) and `league→homeLeague` (4,
   limit 3) do not. The keys are always listed, whether or not a suggestion is made.
3. **One Levenshtein.** `src/cli/commands/events.ts:252-269` already has one (`suggestEventTypes`). It moves verbatim to
   `src/utils/edit-distance.ts`, and both callers import it. An emitter must not import a CLI command module (clipanion,
   typescript), and a second copy is not acceptable.
4. **The OpenAPI `include` description stops pointing at the YAML for spelling.** The allowlisted branch of the
   controller's `@ApiQuery` description says `see api.includes.<route> in the entity YAML`. Once the YAML may say
   `fantasy_teams` while the wire wants `fantasyTeams`, that pointer sends a client to a 400. The two allowlisted
   descriptions (`controller.ejs.t:98`, `:159`) say the paths are written as relation keys (camelCase). The "No include
   is exposed" branch, which is the one the baseline renders, is unchanged.
5. **The smoke gate is `just test-smoke-relationship`, not `just test-smoke`.** The only fixture with an allowlist,
   `test/smoke/fixtures/crm/account.yaml`, belongs to the `relationship` scenario (`run-smoke.ts:77`). The plan's
   `test-smoke` means this recipe. Both are in `just test-all`.
6. **Route keys are not normalised.** `find_by_id` / `list` / `findByX` keep their mixed spelling. A wrong route key
   already fails with the list of valid routes (`build-includes.ts:167-171`). Changing route spelling is a separate
   question from #742 (see Out of scope).
7. **Documentation.** The consumer YAML reference gains an `api:` section (it documents neither `api: false` nor
   `api.includes` today, which is how a host came to guess the spelling). The charter decision log gets one row.

## Architecture

```
entity YAML ──api.includes.<route>.paths──┐
                                          │ per declared path:
                                          │   split '.' → trim → reject empty → max_depth check
                                          │   key_i = camelCase(segment_i)          ← types.ts:115, the SAME fn
                                          │   walk edgesByTable[table][key_i]          build-graph.ts mints keys with
                                          │     miss  → IncludeAllowlistError          (keys at hop + nearest)
                                          │     api:false target → IncludeAllowlistError (declared spelling)
                                          │   add every key-form prefix to `wanted`
                                          ▼
                       wanted (Set<string>, key form, de-duplicated) ──sort──► CompiledIncludePath[]
                                                                               (path, fragment, depth: all keys)
                                          ▼
                       emit-includes.ts ──► <generated>/api-includes.ts   (unchanged renderer)
                                          ▼
                       controller (hygen, unchanged logic) ──► resolveAllowedInclude(?include=, MAP.<route>)
```

## Files

| File | Action | Purpose |
|---|---|---|
| `src/emitters/relations/build-includes.ts` | modify | Normalise segments, validate per declared path, build the new miss message, add the nearest-key helper. Update the header comment and the `CompiledIncludePath.path` doc. |
| `src/utils/edit-distance.ts` | create | `levenshtein(a, b)`, moved verbatim from `events.ts`. |
| `src/cli/commands/events.ts` | modify | Delete the local `levenshtein` (L252-269) and import it from `../../utils/edit-distance.js`. `suggestEventTypes` is unchanged. |
| `templates/entity/new/backend/controller.ejs.t` | modify | L98 and L159, the allowlisted `include` description only (decision 4). |
| `src/__tests__/emitters/relations/build-includes.test.ts` | modify | New `describe` blocks for spelling and miss messages (see Tests). Existing tests are unchanged. |
| `test/smoke/fixtures/crm/account.yaml` | modify | `find_by_id.paths` gains `parent_account` (the YAML name of a two-word relationship). The comment above `paths:` is updated (four keys from three declarations). |
| `test/smoke/run-smoke.ts` | modify | In the `api-includes.ts` block (~L471-500), assert the `parentAccount` key and that there is no `parent_account`. In the controller block (~L503), assert the new description. |
| `docs/specs/REL-2.md` | modify | §5.1 paths bullet (L474): the spelling rule, marked *revised 2026-10-31, #742*. §5.2 (after L484): `?include=` takes relation keys, never the YAML spelling. §6.3 build-includes bullet (L631): mention the spelling and miss-message tests. |
| `consumer-skills/entities/yaml-reference.md` | modify | A new `## api: — HTTP surface + include allowlist` section between `relationships:` (L77-95) and `generate:` (L97). |
| `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` | modify | One row appended to the §7 decision log (after L162). |
| `CHANGELOG.md` | none | The changelog policy carries the text in the PR body (below), and the release PR writes it. |

No change to `runtime/**`, `emit-includes.ts`, `build-graph.ts`, `types.ts`, the schema, `entity-locals.js`, or any
snapshot under `test/baseline/`, `test/relations-golden/`, `test/junction/` or `test/frontend-golden/`.

## Interfaces and emitted shapes

### Types: no signature changes

`CompiledIncludePath`, `CompiledIncludeRoute`, `CompiledEntityIncludes`, `IncludeAllowlistError` and
`buildIncludeAllowlists(ctx, graph)` keep their shapes. Only the doc comment of `CompiledIncludePath.path` changes:

```ts
export interface CompiledIncludePath {
  /**
   * The dot path in RELATION-KEY form: each declared segment normalised with REL-1's
   * `camelCase` (the YAML relationship name and the key name the same edge). This is
   * the key a client sends in `?include=`. A prefix of a declared path is implied.
   */
  path: string;
  fragment: string; // rendered from the key-form segments
  depth: number;
}
```

### New, module-private in `build-includes.ts`

```ts
/**
 * The key at this hop closest to `key` (a camelCase-normalised segment), or undefined
 * when none is close. Lower-cased Levenshtein, limit max(2, floor(maxLen / 3)), ties
 * to the earlier candidate. `candidates` arrive in graph order.
 */
function nearestRelationKey(key: string, candidates: readonly string[]): string | undefined;
```

### New module `src/utils/edit-distance.ts`

```ts
/** Classic Levenshtein edit distance (insert / delete / substitute, cost 1). */
export function levenshtein(a: string, b: string): number;
```

### The miss message (the contract the tests pin)

```
<entity>.api.includes.<route>: '<declared path>' names no relation at '<declared prefix>' — table '<table>' has no relation '<key>'[ (written '<segment>')] in the generated manifest. <keys clause>[ Did you mean '<suggestion>'?]
```

- `<declared prefix>`: the trimmed declared segments up to and including the missing one, joined with `.`.
- `(written '<segment>')`: present only when `camelCase(segment) !== segment`.
- `<keys clause>`: `Relation keys at this hop: k1, k2, k3.` in graph order (already sorted by `localeCompare`,
  `build-graph.ts:335`; do not re-sort). When the table has no edges: `Table '<table>' has no relations, so no path
  continues through it.`
- `Did you mean …`: only when `nearestRelationKey` returns a key.

For example, #742's typo case:

```
league.api.includes.find_by_id: 'fantasy_team' names no relation at 'fantasy_team' — table 'leagues' has no relation 'fantasyTeam' (written 'fantasy_team') in the generated manifest. Relation keys at this hop: fantasyTeams. Did you mean 'fantasyTeams'?
```

The `api: false` traversal message keeps its text and quotes `'<declared path>'`. The empty-segment and max_depth
messages are unchanged.

### Emitted `api-includes.ts` for #742's repro (`paths: [fantasy_teams]`)

```ts
export const LEAGUES_API_INCLUDES = {
	// find_by_id — max_depth 1
	find_by_id: {
		fantasyTeams: { fantasyTeams: true },
	},
} as const satisfies Readonly<Record<string, RouteIncludes<'leagues'>>>;
```

### Emitted smoke `ACCOUNTS_API_INCLUDES.find_by_id` after the fixture change

```ts
	find_by_id: {
		contacts: { contacts: true },
		opportunities: { opportunities: true },
		'opportunities.account': { opportunities: { with: { account: true } } },
		parentAccount: { parentAccount: true },
	},
```

### Controller `include` description (allowlisted branch only)

```
'Comma-separated include paths, written as relation keys (camelCase), allowlisted by api.includes.list in the entity YAML. Anything else is a 400.'
```

`find_by_id` gets the same wording with `api.includes.find_by_id`.

## Implementation steps

1. **Move Levenshtein** (`src/utils/edit-distance.ts`, `src/cli/commands/events.ts`). Copy the function body
   unchanged, export it, delete the local copy, and add the import. Run `just test-unit`: `events-consumers.test.ts`
   (`suggestEventTypes`) stays green.
2. **Restructure the per-route loop** (`build-includes.ts:174-230`):
   - For each `declared` in `decl.paths`: split on `.` and trim. Keep the empty-segment error and the max_depth error
     as they are, quoting `declared`.
   - Set `keys = segments.map(camelCase)` (import `camelCase` from `./types`).
   - Walk from `table = entity.plural`. For each index `i`: `edges = edgesByTable.get(table)` and
     `edge = edges?.get(keys[i])`.
     - Miss: throw `IncludeAllowlistError` with the message contract above. The candidates are
       `[...(edges?.keys() ?? [])]`.
     - Hit: run the existing `api: false` check, quoting `declared`. Then `table = edge.targetTable`.
   - After a full walk, add every key-form prefix (`keys.slice(0, i).join('.')`) to `wanted`.
   - The rendering loop over `[...wanted].sort()` keeps only `renderFragment(path.split('.'))` and `depth`. It does no
     second lookup, because every prefix of a walked path was walked.
3. **Add `nearestRelationKey`** (module-private, beside `renderFragment`).
4. **Update the comments** in `build-includes.ts`: a header paragraph on spelling (one rule, `camelCase`, keys on the
   wire), and the `CompiledIncludePath.path` doc above.
5. **Controller description** (`controller.ejs.t` L98, L159). Text only, allowlisted branch only.
6. **Unit tests** (below).
7. **Smoke fixture and assertions** (below).
8. **Docs**: REL-2 §5.1, §5.2 and §6.3; the consumer `yaml-reference.md` `api:` section (both YAML forms of `api:`,
   the allowlist, the spelling rule, clients send keys, the four generation errors, no host names); the charter §7
   row:
   `| 2026-10-31 | Include-path segments accept the YAML relationship name or the relation key, normalised by REL-1's own camelCase; the compiled allowlist and ?include= stay in relation keys (#742). | docs/specs/REL-2.md §5.1 |`.
   Per charter §9, when the PR merges, a log entry goes on its epic if #742 is ever parented. At `a8629dfc` it has no
   parent.

## Tests and gates

### Unit: `just test-unit` → `src/__tests__/emitters/relations/build-includes.test.ts`

Fixtures are built through `EntityDefinitionSchema.parse`, as the file already does. Add:
`LEAGUE` (`fantasy_teams: has_many fantasy_team, fk league_id`), `FANTASY_TEAM` (`league_id` uuid required;
`home_league: belongs_to league`), `SPONSOR_BRAND` (no relationships) plus a `JunctionDefinitionSchema.parse({ pattern:
'Junction', between: ['league', 'sponsor_brand'] })` passed as `ctx.junctions` (extend `ctxOf` with an optional
junctions argument). Also add `TROPHY` (no relationships), reached by an inline `trophies: has_many trophy` on a
`LEAGUE` variant. S1–S3, S5 and M1–M3 compile `[LEAGUE, FANTASY_TEAM]` only, so the keys on `leagues` are exactly
`fantasyTeams`. S4 adds `SPONSOR_BRAND` and the junction. M4 uses the existing `ACCOUNT, CONTACT, OPPORTUNITY`. M5
uses the trophies variant with `FANTASY_TEAM` and `TROPHY`.

`describe('buildIncludeAllowlists — path spelling (#742)')`:

| # | Test | Asserts | On base `a8629dfc` |
|---|---|---|---|
| S1 | #742's repro: the YAML relationship name compiles to the relation key | `paths: ['fantasy_teams']` → `[['fantasyTeams', '{ fantasyTeams: true }', 1]]` | **red**: throws `has no relation 'fantasy_teams'` |
| S2 | every hop is normalised; the fragment is written in keys | `['fantasy_teams.home_league']`, depth 2 → `fantasyTeams` and `fantasyTeams.homeLeague` with `{ fantasyTeams: { with: { homeLeague: true } } }` | **red**: throws at `'fantasy_teams'` |
| S3 | both spellings name one edge, so there is one entry | `['fantasy_teams', 'fantasyTeams']` → exactly `['fantasyTeams']` | **red**: throws |
| S4 | junction-derived keys are spelled from their source names | `['sponsor_brands', 'league_sponsor_brands']` → `['leagueSponsorBrands', 'sponsorBrands']` | **red**: throws `has no relation 'sponsor_brands'` |
| S5 | the emitted map is keyed by the relation key | `buildApiIncludes(compile(S1))` contains `\t\tfantasyTeams: { fantasyTeams: true },` and no `fantasy_teams` | **red**: `compile` throws |

`describe('buildIncludeAllowlists — a miss says what exists (#742)')`:

| # | Test | Asserts | On base |
|---|---|---|---|
| M1 | a near miss lists the keys and suggests one | `['fantasy_team']` → `IncludeAllowlistError` whose message contains `names no relation at 'fantasy_team'`, `has no relation 'fantasyTeam' (written 'fantasy_team')`, `Relation keys at this hop: fantasyTeams.` and `Did you mean 'fantasyTeams'?` | **red**: no keys and no suggestion in the message |
| M2 | a nested miss reports the hop it missed at | `['fantasy_teams.league']` → contains `names no relation at 'fantasy_teams.league'`, `table 'fantasy_teams'` and `Relation keys at this hop: homeLeague.` | **red**: base fails at `'fantasy_teams'` |
| M3 | a case slip is suggested | `['FantasyTeams']` → contains `Did you mean 'fantasyTeams'?` | **red** |
| M4 | nothing close, so keys are listed and nothing is guessed | ACCOUNT `['nope']` → contains `Relation keys at this hop: contacts, opportunities.` and does **not** contain `Did you mean` | **red**: no keys clause |
| M5 | a hop into a table with no relations says so | LEAGUE-with-trophies, `max_depth: 2`, `['trophies.x']` → contains `Table 'trophies' has no relations` | **red** |

Unchanged and still green: all 24 existing tests in this file (prefix implication, route independence, max_depth,
route keys, `api: false` both ways, the no-own-relation errors, the emitted file, the `declaresOwnRelation` parity),
plus `route-name-parity.test.ts` and `events-consumers.test.ts` (`suggestEventTypes`, after the move).

### Smoke: `just test-smoke-relationship` (in `just test-all`)

- Fixture: `test/smoke/fixtures/crm/account.yaml` `find_by_id.paths` becomes `[contacts, opportunities.account,
  parent_account]` (`max_depth: 2` is unchanged).
- New assertions in the `api-includes.ts` block:
  `/\t\tparentAccount: \{ parentAccount: true \},/` ("keys a YAML-spelled path by its relation key (#742)"), and
  `apiIncludes` does not include `parent_account`.
- New assertion in the controller block: `account.controller.ts` contains `written as relation keys (camelCase)`.
- The consumer `tsc` re-checks `{ parentAccount: true }` against `IncludeOf<'accounts'>` through the `satisfies`, so a
  normalisation that produced a key the manifest lacks fails `tsc`, not only the grep.
- **Fails on its own subject on base.** The scratch run over these exact fixture files with `parent_account` added
  threw `account.api.includes.find_by_id: 'parent_account' names no relation at 'parent_account' — table 'accounts'
  has no relation 'parent_account'`. In the smoke, that is `entity new --all --force` exiting 1
  (`entity.ts:627` sets `relationsFailed`, and `:1031` returns 1), and `run()` (`execSync`) throws, so the gate is red before any assertion runs.

### Non-regression gates

- `just test-baseline`: snapshots are byte-identical. No baseline fixture declares `api.includes`, and the baseline
  controllers (`deals`, `deal-states`, …) render only the unchanged "No include is exposed" branch. This gate fails on
  its own subject if decision 4's edit lands in the wrong branch: the snapshot compare would show it.
- `just typecheck`: covers the moved `levenshtein` and the new import in `events.ts`.
- `just test-integration` (its own CI job, Docker): `test/scaffold/entities/account-scaffold.yaml` declares
  `contacts` only, which emits the same output, so the HTTP allowlist tests (H1–H3) are unchanged. Not run at spec
  time (no Docker). CI runs it.
- `test/relations-golden/` pins only `relations.ts`, which this PR does not touch.

Cheap checks run at spec time (`nice -n 19`, no Docker): the base reproduction above and the existing 31 relations
tests (green). `just test-all` was not run.

## Charter invariants (`PROJECT.md` §4) this PR touches

- **I1, declare once.** The key comes from the same `camelCase` that minted it. No second spelling table, and no
  re-derivation in the hygen half (the controller still reads only route keys).
- **I6, HTTP closed by default.** Still only compile-time literals that the graph walk checked. The wire contract stays
  the relation key, and `satisfies` still re-checks every fragment.
- **I7, no backwards compatibility.** There is no alias path: one normalisation, which is idempotent on keys.
- **I9, honest gates.** Every new test and the smoke leg are shown red on `a8629dfc` (tables above). No filter, and no
  change to `_consumer-errors.ts`.
- **I10, public repo.** Fixtures use the issue's own public repro names and the existing crm fixtures.

## Out of scope

- Normalising `?include=` at runtime (`runtime/http/includes.ts`). The wire is the key, the same as the response
  property names.
- Route-key spelling (`find_by_id` vs `findByName`). Its error already lists valid routes. If it is ever changed, it
  is a separate decision with its own parity test (#711).
- Listing allowed paths in the runtime 400 body (`IncludeNotAllowedError` says only `include not allowed: '<path>'`).
- A dedicated hint when a segment names a transitive (`through:`) relationship. The keys list already shows that it is
  not an edge.

## Restack notes

Independent. It merges after stacks A, B and C. The overlap is textual only: `run-smoke.ts` (B #811/#814 add
fixtures; A #796 adds a timestamp assertion), `controller.ejs.t` (C #813 qualifies `Record`), and
`consumer-skills/entities/yaml-reference.md` (A #784/#796 and C #813 edit other sections). Resolve by keeping both
sides. Nothing here regenerates a snapshot.

## Changelog (the PR body carries this block verbatim)

```
Changelog:
### Fixed
- `api.includes.<route>.paths` accept the YAML relationship name as well as the relation key: `paths: [fantasy_teams]`
  and `paths: [fantasyTeams]` name the same edge. Every segment is normalised with the relations manifest's own
  camelCase, so nothing becomes ambiguous; the emitted allowlist and the `?include=` wire format stay in relation
  keys (`?include=fantasyTeams`). A segment that names no relation now fails generation with the relation keys
  available at that hop and, when one is close, "Did you mean '<key>'?". The generated controller's `include`
  OpenAPI description now says paths are written as relation keys. Existing allowlists emit byte-identical output.
  (#742)
```

No upgrade step: existing camelCase allowlists compile unchanged, and clients keep sending relation keys.

## References

- Issue #742; plan leaf `include-paths-relationship-names` (Gate 0, 2026-10-31).
- `docs/specs/REL-2.md` §5 (HTTP surface), §6.3 (unit tests), §10 Found #10 (the `declaresOwnRelation` parity this
  leaves untouched).
- `docs/specs/REL-1.md` (key derivation), `src/emitters/relations/build-graph.ts`.
- `src/cli/commands/events.ts` `suggestEventTypes` (the existing did-you-mean precedent).
