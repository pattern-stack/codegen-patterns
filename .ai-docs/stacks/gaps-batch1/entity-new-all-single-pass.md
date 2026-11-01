---
issue: pattern-stack/codegen-patterns#815
github_issue: https://github.com/pattern-stack/codegen-patterns/issues/815
stack: gaps-batch1
stack_position: "C: generator-correctness (2 of 2, after #813; no code dependency, shared baseline snapshots)"
key: entity-new-all-single-pass
layer: L0
size: M
gate: auto
status: strategy-approved
base: origin/main @ a8629dfc
branch: dugshub/815-entity-new-all-single-pass
plan: ".ai-docs/stacks/gaps-batch1/plan.yaml on branch dugshub/gaps-batch1-plan (Gate 0 approved 2026-10-31 with every open_questions recommendation)"
related:
  - docs/specs/NAME-0.md                # §3: has_many stays a soft, file-on-disk check (gets a dated note here)
  - docs/specs/JUNC-0.md                # `junction new` re-renders both parents through renderEntityTargets
  - pattern-stack/codegen-patterns#813  # Stack C sibling: regenerates test/baseline/**; this PR must reproduce it single-pass
  - pattern-stack/codegen-patterns#632  # repositoryDeps: one import/injection per composed target
---

# Spec: #815. `entity new --all` wires every `has_many` in one pass

PR title: `fix(#815): \`entity new --all\` wires every has_many in one pass`

## Goal

On a clean tree, one `codegen entity new --all` must produce the same files as two runs. Today it does not: a parent
rendered before its `has_many` target gets no composition method, and no import, constructor parameter or provider
for the target's repository. Nothing warns. A second run adds them. A host application runs `--all --force` twice in
CI to get a stable tree.

The fix keeps the existence check that protects a single-file `entity new`. It adds one more source of truth: the set
of entities this run is about to render. The two harnesses that work around the defect today (the baseline runner and
the relationship smoke) drop their second pass. Each one then fails on the base commit.

## Root cause (checked at a8629dfc)

| Where | What it does |
|---|---|
| **`templates/entity/new/backend/entity-locals.js:642-688`** (`processHasMany`) | **`targetExists` is true for a self-reference, or when `<target moduleDir>/<kebab stem>.entity.ts` is on disk (`fs.existsSync`, L665-670). This is the defect.** The comment at L655-664 names the two-pass requirement. |
| `entity-locals.js:1745-1753` | Only `targetExists` edges reach `repositoryDeps`: the service's import, injection and constructor parameter, and the module's import and provider. |
| `entity-locals.js:2184`, `:2361` | The same filter feeds the forwarder-collision check and `existingHasMany`, which `service.ejs.t:144, 172-185` renders as `async <rel>(<entity>Id, opts?)`. |
| `src/cli/commands/entity.ts:276-281` | `--all` lists `listEntityYamls`. `findYamlFiles` returns the paths sorted (`src/utils/find-yaml-files.ts:63`). |
| `src/cli/shared/entity-render.ts:251-283` | `renderEntityTargets` spawns one hygen subprocess per target, in that order. Each invocation gets only its own YAML path (`invokeEntityNew`, `src/cli/shared/hygen.ts:175-186`). |
| `test/run-test.ts:155-188` | The baseline runner runs two passes "so the second pass's `targetExists` checks resolve". |
| `test/smoke/run-smoke.ts:652-665` | The relationship smoke runs `entity new --all` twice "so cross-entity `has_many` targets are on disk for the second pass". |

`entity-locals.js:667` is the only read of generated output in the entity render path. Every other cross-entity fact
comes from YAML: target naming (`templates/_shared/entity-naming.mjs`), the junction fan-out
(`templates/_shared/junction-fan-out.mjs`) and the owned-table set (`prompt.js` `loadOwnedTableNames`). So the file
check is the only source of run-order dependence.

**Measured on the base commit.** A probe ran the base CLI (`bun src/cli/index.ts entity new --all --force`) twice
over the smoke CRM set (`test/smoke/fixtures/crm/`: `account` has_many `contacts` and `opportunities`, and `account`
sorts first). The first run left out `async contacts(`. Between the two runs, `diff -r` of `src/` found **exactly two
changed files**: `modules/accounts/account.service.ts` (two repository imports, two entity-type imports, two
constructor parameters, and the `contacts` and `opportunities` methods) and `modules/accounts/accounts.module.ts`
(two repository imports and two providers). Every other file under `src/` was byte-identical, post-step output
included.

## Decisions

The plan settled the shape: under `--all`, the existence check also accepts a target in the set being rendered. The
CLI passes that set to each hygen invocation, a single-file `entity new` keeps the pure file check, and the baseline
runner goes to one pass. The spec settles the rest:

1. **The set is the batch being rendered, not a flag for `--all` mode.** `renderEntityTargets` passes the names of
   every target it renders (its `validated` list) to every invocation. Under `--all` that is the whole validated set.
   For a single file it is `[x]`, which adds nothing to the self-reference case, so a single-file `entity new` is the
   pure file check that #815 asks to keep. `junction new` re-renders the parents of its junctions through the same
   function (`src/cli/commands/junction.ts:308`), so the same ordering defect between two parents is fixed there too.
   No `--all` flag crosses into the template.
2. **The wiring rule.** A `has_many` target is wired when it resolves to an entity YAML **and** it is a
   self-reference, or it is in the render set, or its entity file is on disk. The file check stays: a single-file
   regeneration of a parent still wires a target that an earlier run generated. A target with no YAML stays a soft
   skip (NAME-0), even if its name is in the set.
3. **Transport: one hygen argument, `--renderSet <names joined by ','>`.** It has one writer,
   `entityNewArgs(yamlPath, renderSet)` in `src/cli/shared/hygen.ts`. Both `invokeEntityNew` and the baseline runner
   build their hygen arguments with it, so the runner exercises the CLI's own mechanism. It has one reader, in
   `templates/entity/new/prompt.js`. A comma is safe because entity names match `^[a-z][a-z0-9_]*$`
   (`entity-definition.schema.ts:626`). The parser hygen uses (yargs-parser 21.1.1, hygen 6.2.11) keeps the value a
   string: a probe passed `true`, `e1`, `deal_state` and `a,b_c,deal_state`, and each came back as a string. An
   argument rather than an environment variable, because the set belongs to one invocation, it shows up in
   `HygenResult.command` when a render fails, and it cannot leak in from an ambient environment.
4. **An absent `--renderSet` means the empty set, which leaves only the file check.** A direct
   `bunx hygen entity new --yaml x` renders only `x`, so the empty set is the right answer there, not a fallback.
   This does not break CLAUDE.md gate rule (c): an absent value gives the strict pre-fix behaviour, never a
   permissive one. Dropping the key shows up as a missing composition, and two gates in `just test-all` go red on
   it: the single-pass baseline (if `prompt.js` or the runner drops it) and the relationship smoke (if the CLI drops
   it). This answers the spread-to-explicit-key-list hazard for the new `prompt.js` key.
5. **A failure in the middle of a run.** A validated target whose hygen render fails during `--continue-on-error`
   (the default) stays in the set. A parent may then import a repository the run did not write, and `tsc` reports
   it. The run has already failed: `entity new` exits 1 on any failed target (`entity.ts:1031`). The plan accepted
   this. A target rejected at pre-flight is not in `validated`, so it is not in the set, and its parents fall back
   to the file check, as on base.
6. **`targetExists` and `existingHasMany` keep their names.** Their doc comments change to "exists when this run
   finishes". Renaming them would touch `service.ejs.t` and the NAME-0 tests without changing a byte of output.
7. **Rejected alternatives.** A second pass inside `--all` (the issue's "or") doubles the cost of every
   regeneration and hides the defect instead of removing it. Rendering targets before parents does not work in
   general: two entities may each declare a `has_many` onto the other, and then no order puts both targets first.
8. **The CLI needs its own gate.** The baseline runner drives hygen directly, so it cannot see `renderEntityTargets`.
   The relationship smoke can: it runs the real CLI over the CRM set. It drops its own second pass, keeps its
   existing `async contacts(` assertion, and adds a check that a second run changes no file. That check is the issue's
   first "Done when", asserted literally.

## Interfaces

Signatures and contracts only. The bodies are the implementer's.

- **`src/cli/shared/hygen.ts`**
  - New: `export function entityNewArgs(absoluteYamlPath: string, renderSet: readonly string[]): string[]`. Returns
    `['--yaml', absoluteYamlPath, '--renderSet', renderSet.join(',')]`. This is the one definition of the wire
    format.
  - Changed: `invokeEntityNew(absoluteYamlPath: string, renderSet: readonly string[], cwd?: string, configPath?: string | null): HygenResult`.
    `renderSet` is **required** and is the second parameter, so every caller has to decide what it renders.
    `args: entityNewArgs(absoluteYamlPath, renderSet)`.
- **`src/cli/shared/entity-render.ts`**: the `renderEntityTargets(ctx, validated, opts)` signature is unchanged.
  It computes `validated.map((v) => v.name)` once and passes it to every `invokeEntityNew`. Its doc comment says
  why: the render set makes `has_many` wiring independent of render order. Both `entity new` and `junction new`
  inherit the change.
- **`templates/entity/new/prompt.js`**: reads `args.renderSet` into `string[]`. It splits on `,` and drops empty
  entries. An absent value gives `[]` (decision 4). It passes `renderSet` in the explicit key list of the
  `buildBackendLocals` call (L381-396), with a comment that names #815, the absent-means-empty rule, and the two gates
  that catch a dropped key. The header's usage line shows the optional `--renderSet`.
- **`templates/entity/new/backend/entity-locals.js`**
  - `buildBackendLocals` reads `baseLocals.renderSet` (`string[] | undefined`) into a `Set<string>`. It is an input,
    not a returned template local.
  - `processHasMany(relationships, naming, renderSet)`: the third parameter is the `Set<string>`. The wiring rule is
    decision 2. The comment at L655-664 is rewritten: a file check plus the render set, and why the file check is
    kept (a single-file regeneration). "Two-pass generation" goes.

## File-level plan

| File | Change |
|---|---|
| `src/cli/shared/hygen.ts` | Add `entityNewArgs`. Change `invokeEntityNew` as above. Its doc comment names `--renderSet` and #815. |
| `src/cli/shared/entity-render.ts` | `renderEntityTargets` passes the batch's names (Interfaces). |
| `templates/entity/new/prompt.js` | Read `--renderSet` and pass it to `buildBackendLocals` (Interfaces). |
| `templates/entity/new/backend/entity-locals.js` | `processHasMany` takes and applies the render set. Thread it from `buildBackendLocals` (L1745). Rewrite the L655-664 comment. |
| `test/run-test.ts` | **One pass.** Read each fixture's `entity.name` with `yaml` (a root dependency). Each hygen call is `bunx --bun hygen entity new <entityNewArgs(yamlPath, names)>`, keeping the runner's own `HYGEN_TMPLS`, `cwd: ROOT`, `stdio: 'pipe'` and throw-on-failure. Delete `runPass` and the "Pass 1 / Pass 2" logs. Rewrite the comments at L131-135 (pristine state), L141-145 (the sort is kept for deterministic logs and output, and no longer needed for `targetExists`) and L155-163 (two-pass). |
| `test/smoke/run-smoke.ts` | Relationship scenario, step 5 (L652-665): run `entity new --all --force` **once**, then snapshot every file under `<tmpDir>/src` (relative path → contents). Steps 5.1/5.2 (`assertRelationshipEmission`, `assertSemanticEmission`) run unchanged on that one-run tree. Then run `entity new --all --force` again and assert `src/` is unchanged (S2 below). The failure lists every added, removed or changed path, not just the first. Rewrite the step-5 comment. |
| `test/smoke/run-smoke-subsystems.ts` | L226-232: keep the second run (it exists for the bridge install, not for `has_many`). Delete the clause "matches the two-pass pattern already used by the relationship scenario", which is no longer true. |
| `src/__tests__/backend/target-naming.test.ts` | U1-U3 in the existing `describe('has_many')` (L127). |
| `src/__tests__/cli/hygen.test.ts` | U4-U5. Update `appends --yaml arg via invokeEntityNew` (L77) to the new signature. |
| `CLAUDE.md` | *Testing → Baseline tests*: replace "Two-pass generation (the first pass seeds every `<entity>.entity.ts` so the second pass's `targetExists` checks resolve cross-entity imports)." with "One pass, as `entity new --all` runs it: every hygen call gets the whole fixture set as `--renderSet` (`entityNewArgs`, #815), so a `has_many` onto an entity later in the run is wired without a seeding pass." |
| `.claude/skills/codegen/SKILL.md` | L101-102: replace "— or one not generated yet — is not wired (the two-pass `targetExists` check), not an error." with: a `has_many` onto a target with no YAML is not wired, and that is not an error. One onto a target with a YAML is wired when the same run generates the target (`--all`, or a junction's two parents) or the target is already on disk. A single-file `entity new` of the parent leaves it unwired until the target exists (#815). |
| `consumer-skills/entities/yaml-reference.md` | L90-91: after "regenerate the set with `codegen entity new --all`", add: one run is enough, and every `has_many` onto an entity in the run is wired. A single-file `entity new <parent>.yaml` wires a `has_many` only when its target has already been generated. |
| `docs/specs/NAME-0.md` | L63-65 (`has_many` → unchanged soft behaviour): dated revision note *2026-10-31 (#815)*. The check is the file on disk **or** membership in the run's render set (`--renderSet`), and two-pass generation is gone. The soft skip for a target with no YAML is unchanged. |

No template file (`*.ejs.t`) changes. The emitted shape for a wired `has_many` is the one the second pass already
produces.

## Emitted shapes

There is no new shape: one run now emits what two runs emitted on base. For the smoke CRM set, the one-run
`modules/accounts/account.service.ts` gains, compared with a one-run tree on base:

```ts
import { ContactRepository } from '../contacts/contact.repository';
import type { Contact } from '../contacts/contact.entity';
import { OpportunityRepository } from '../opportunities/opportunity.repository';
import type { Opportunity } from '../opportunities/opportunity.entity';
// …
  constructor(
    protected override readonly repository: AccountRepository,
    private readonly contactRepo: ContactRepository,
    private readonly opportunityRepo: OpportunityRepository,
  ) {
// …
  async contacts(accountId: string, opts?: { cursor?: string; limit?: number }): Promise<Contact[]> {
    return this.contactRepo.findByAccountId(accountId, opts);
  }

  async opportunities(accountId: string, opts?: { cursor?: string; limit?: number }): Promise<Opportunity[]> {
    return this.opportunityRepo.findByAccountId(accountId, opts);
  }
```

`modules/accounts/accounts.module.ts` gains the two repository imports and `ContactRepository,
OpportunityRepository` in `providers:`. These lines are the probe's run-1 → run-2 diff on base, verbatim apart from
the elisions.

The baseline snapshots do not change. `test/baseline/packages/api/src/modules/deal-states/deal-state.service.ts:14-15,
29, 71-73` and `deal-states.module.ts:5, 30` already hold the composition that the second pass produced.

## Tests

`target-naming.test.ts` uses its own `localsFor` / `roster` helpers and passes `renderSet` through the `base`
argument. `crew` (context `org`) has_many `person` (`plural: persons`), as in the existing has_many tests.

| # | Test | On base |
|---|---|---|
| U1 | *A target the same run renders is wired with nothing on disk (#815).* A fresh tmp `modulesDir` and `renderSet: ['crew', 'person']`. Expect `hasMany[0].targetExists === true`, `existingHasMany` named `['members']`, and a `PersonRepository` entry in `repositoryDeps`. The rendered `service.ejs.t` contains `async members(crewId: string, opts?: { cursor?: string; limit?: number }): Promise<Person[]> {` and `import { PersonRepository } from '../../persons/person.repository';`. The rendered `module.ejs.t` contains that import too. | **red.** A probe on base passed `renderSet` to `buildBackendLocals` for `deal_state` on a pristine tree: `existingHasMany = []`, and the service had no `async opportunities(`. |
| U2 | *A single-entity render keeps the file check.* `renderSet: ['crew']` on a pristine tree gives `targetExists === false`. After `persons/person.entity.ts` is written, it is `true`. | green (pin for the single-file rule) |
| U3 | *The render set does not wire a target that has no entity YAML.* `renderSet: ['crew', 'ghost']` with a `ghosts` has_many gives `{ targetExists: false, targetPlural: null, importPath: null }`. | green (pin for NAME-0's soft skip) |
| U4 | `entityNewArgs('/x/a.yaml', ['account', 'contact'])` deep-equals `['--yaml', '/x/a.yaml', '--renderSet', 'account,contact']`. | **red** (no such export) |
| U5 | `invokeEntityNew('/tmp/does-not-exist.yaml', ['a', 'b']).command` ends with `--yaml /tmp/does-not-exist.yaml --renderSet a,b`. This replaces the existing L77 test and uses the file's `captureCommand`. | **red.** On base the array lands in `cwd`, and the composed command has no `--renderSet`. |

Smoke assertions (relationship scenario):

| # | Assertion | On base, with this PR's harness |
|---|---|---|
| S1 | The existing `assertRelationshipEmission` check `accounts.service.ts contacts(accountId, opts) composition method` (`run-smoke.ts:354-358`), now run after **one** `entity new --all`. | **red.** Probe: after one base run, `grep -c "async contacts("` on `account.service.ts` gave 0. |
| S2 | A second `entity new --all --force` leaves every file under `src/` byte-identical: same path set, same contents. | **red, with exactly the subject.** Probe: run 1 → run 2 on base changed exactly `modules/accounts/account.service.ts` and `modules/accounts/accounts.module.ts`. |

There is no prompt-level unit test. `prompt.js`'s threading of `--renderSet` is pinned end to end: the baseline goes
red if the runner or `prompt.js` drops it, and S1/S2 go red if the CLI does.

## Gates, and proof that each one can fail on its own subject

| Gate | Its subject in this PR | On base a8629dfc + this PR's tests and harness changes |
|---|---|---|
| `just test-unit` | U1, U4, U5 (the template rule and the wire format) | **red.** U1 by probe (above). U4 and U5 by construction. |
| `just test-baseline` | a single pass reproduces the snapshots | **red, on exactly two files.** The runner wipes `OUTPUT_PATHS` and renders the sorted fixtures `account, contact-v2, deal_state, demo-deal, opportunity, organization, person, tenant, user`, so `deal_state` (has_many `opportunities`) renders before `opportunity`. A probe on base with a pristine `modulesDir` gave `existingHasMany = []` for `deal_state` with or without `renderSet` (base ignores it), and `["opportunities"]` once `opportunities/opportunity.entity.ts` existed. The compare therefore fails on `deal-states/deal-state.service.ts` and `deal-states/deal-states.module.ts`. The other has_many parents (`organization`, `user`) sort after `opportunity`, and `organization`'s self-reference is always wired, so nothing else differs. The typecheck step stays green either way, because a missing method is not a type error. The compare is the subject. |
| `just test-smoke-relationship` | S1 and S2 (the CLI half and the "same files as two runs" acceptance) | **red** (S1 and S2 above) |
| `just test-smoke-capability`, `just test-smoke-frontend` | consumers whose first-run output changes (see *Checked and unchanged*) | green before and after. These are regression gates, not this PR's subject. |

Every gate above is already in `just test-all`. No gate wiring changes.

## Build order

1. **Gate commit.** U1-U5. `run-test.ts` goes single-pass and passes the set as a **hand-built** `--renderSet <names>`
   argument (`entityNewArgs` does not exist yet, and an import error is not the subject). `run-smoke.ts` gets one run,
   S2, and the step-5 comment. Run `nice -n 19 bun test src/__tests__/backend/target-naming.test.ts
   src/__tests__/cli/hygen.test.ts`: U1, U4 and U5 should fail. Run `nice -n 19 just test-baseline`: the compare
   should fail on the two `deal-states/` files. Run `nice -n 19 just test-smoke-relationship`: S1 should throw (S2 is
   not reached until S1 passes; to show S2 red too, temporarily run S2 before S1, or report the probe diff above).
   Paste the red excerpts into the PR body.
2. **Fix commit.** `hygen.ts`, `entity-render.ts`, `prompt.js`, `entity-locals.js`. Switch `run-test.ts` from the
   hand-built argument to `entityNewArgs`.
3. **Docs commit.** The comments in `entity-locals.js`, `run-test.ts`, `run-smoke.ts` and `run-smoke-subsystems.ts`,
   plus `CLAUDE.md`, the codegen skill, `yaml-reference.md` and the NAME-0 note.
4. **Green.** `just test-unit`, `just test-baseline` (no snapshot diff; **do not regenerate**),
   `just test-smoke-relationship`, `just test-smoke-capability`, `just test-smoke-frontend`, `just test-junction`,
   and `just typecheck`. `just test-integration` runs in its own CI job (Docker; see below).

Base the branch on `origin/main`. When restacking Stack C, it goes after #813 (`reserved-entity-names`). #813
regenerates `test/baseline/**`. After the restack, run `just test-baseline` single-pass on top of #813, and it must
pass **with #813's snapshots unchanged**. If a snapshot differs, the single pass and #813 disagree, and that is a
finding to report, not a snapshot to regenerate. Snapshot conflicts elsewhere in the batch (#796) are resolved by
regenerating, as `merge_order` says, never by hand-merging.

## Checked and unchanged

- **`belongs_to` never checks existence.** It always imports the target's table and needs the target's YAML
  (NAME-0). It is not order-dependent and does not change.
- **Whole-set emitters** (relations manifest, include allowlist, semantic model, frontend graph, barrels) read YAML.
  They do not change. The probe's run-1 → run-2 diff touched no file under `src/generated/`.
- **`test-junction` snapshots:** the junction harness fixtures declare no `has_many`, so they are unchanged.
  `test/relations-golden/` and `test/semantic-golden/` are TS-emitter goldens built from YAML, also unchanged.
- **Consumers whose first-run output gets more correct.** Each of these used to run `--all` once with a parent
  sorted before its target:
  - the capability smoke: `account` → `contacts`;
  - the frontend smoke: `account` → `opportunities`;
  - the scaffold integration suite: `account` → `contacts` / `opportunities`, `region` → `sites`.

  Their parents now get the composition on the first run. That is the output two runs gave on base, and a host
  application's tree already has it. The composed repositories inject only `DRIZZLE` (`repository.ejs.t:221`), which
  each module's `DatabaseModule` import provides. The EAV-value repository (`repository.ejs.t:201-203`) is not a
  target in any of these. `just test-integration` boots the scaffold's `AppModule` (`test/scaffold/tests/http.test.ts:30`)
  and so exercises this DI in its own CI job. It cannot run here (Docker).
- **The forwarder-collision check** (`entity-locals.js:2157-2190`) now sees a `has_many` name on the first run. A
  collision that used to surface only on a second run now surfaces on the first, which is the correct order. The
  capability `account` has `contacts` against the forwarders `members`, `principal` and `auditCount`, so there is no
  collision.
- **`junction new`** passes its parents' names as the set (decision 1). The junction-first bootstrap in
  `run-smoke-junction.ts` (L729-733) keeps passing. Its fixtures have no `has_many`.
- **Package mode and vendored mode** are unaffected: the render set changes which edges are wired, not any import
  specifier.
- **Studio** shells the CLI (`src/studio/server/cli-runner.ts`), so it gets the fix without a change.

## Acceptance

- [ ] On an empty output tree, one `entity new --all` produces the same files as two runs (S2, relationship smoke).
- [ ] A parent generated before its `has_many` target has the composition after one run: U1 at the template level,
      S1 through the CLI, and `deal_state` → `opportunities` in the single-pass baseline.
- [ ] A single-file `entity new` keeps the pure file check (U2), and a target with no YAML stays unwired (U3).
- [ ] `invokeEntityNew` takes a required render set, and `renderEntityTargets` passes its whole batch (U4, U5, S1).
- [ ] `just test-baseline` passes **single-pass** with no snapshot change. After the restack onto #813, it passes
      against #813's regenerated snapshots.
- [ ] The PR body shows the gate commit red: U1/U4/U5, the baseline compare on the two `deal-states/` files, and S1
      (or S2).
- [ ] `just test-smoke-capability`, `just test-smoke-frontend` and `just test-junction` stay green.
      `test-integration` is green in CI.
- [ ] No comment, doc or skill says "two-pass" about entity generation: `entity-locals.js`, `run-test.ts`,
      `run-smoke.ts`, `run-smoke-subsystems.ts`, `CLAUDE.md`, the codegen skill, `yaml-reference.md`, and the NAME-0
      note.
- [ ] The PR body carries the Changelog block below.

## Changelog block (PR body)

```
Changelog:
### Fixed
- `entity new --all` wires every `has_many` in one run. On a clean tree, a parent generated before its `has_many`
  target used to get no composition method (`<parent>Service.<relation>(…)`), and no import, constructor parameter or
  module provider for the target's repository, until the command ran a second time. A `has_many` is now wired when its
  target is generated in the same run or is already on disk. A single-file `entity new <file>` still wires a
  `has_many` only when the target has already been generated. `junction new`, which regenerates the two parents of
  each junction, follows the same rule. (#815)
  Upgrade: nothing to migrate, and no schema or DDL change. Regenerating a tree that was generated twice changes no
  file. A tree that was generated once gains the missing composition methods. Remove any second
  `entity new --all` run from scripts and CI.
```
