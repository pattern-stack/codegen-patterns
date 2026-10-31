---
issue: pattern-stack/codegen-patterns#814
plan: .ai-docs/stacks/gaps-batch1/plan.yaml   # on dugshub/gaps-batch1-plan; Gate 0 approved 2026-10-31
plan_key: package-mode-typed-event-bus
stack: gaps-batch1 / B (generated-tree-compile-fixes), first of [package-mode-typed-event-bus, api-false-barrel]
base_commit: a8629dfc
layer: L0
size: M (code S; the gate is most of the work)
gate: auto
status: strategy-approved
related:
  - docs/adrs/ADR-037-runtime-mode-and-namespaced-tokens.md   # runtime modes
  - docs/specs/EVT-7.md                                       # typed `emits:` emission (decision 4 gets a revision note)
  - runtime/subsystems/index.ts                               # L15-25: why the barrel forwards the token only
  - src/cli/shared/subsystem-barrel-generator.ts              # L263-273: the package-mode precedent, `./events/bus`
---

# Spec: #814, package-mode write use cases import `TypedEventBus` from the project's own generated bus

## Why

A host application runs with `runtime: package` (the ADR-037 default). For every entity that declares `emits:`,
the generated create, update and delete use cases contain:

```ts
import { TYPED_EVENT_BUS, TypedEventBus } from '@pattern-stack/codegen/subsystems';
```

The barrel exports the token and not the class. `runtime/subsystems/index.ts` L15-25 says why, and the reason is
correct: the package's own `TypedEventBus` is typed to the package's event union. The class a use case needs is the
project's own generated bus, typed to the project's events. `EventsModule.forRoot({ typedBus })` binds that class to
the token (`events.module.ts` L261-268), and the package-mode subsystem barrel imports it from `./events/bus`
(`subsystem-barrel-generator.ts` L263-273). The use-case templates are the only generator that still asks the
package for the class. The host rewrites the import after every generation.

No gate catches this. The only `emits:` fixture anywhere is `test/fixtures/entities/contact-v2.yaml`, in the
**vendored** baseline, and it emits on create only. No package-mode gate has ever compiled an `emits:` use case, and
no gate in either mode has compiled the update or delete emits bodies.

## Measured at a8629dfc

- **Diagnostic.** The code is **TS2724**, not the TS2305 the issue and plan name. TS2724 is the same "no exported
  member" error with a spelling suggestion, and tsc suggests `TYPED_EVENT_BUS`. Reproduced with tsc 5.9.3 against the
  base barrel, through the same `paths` entry `aliasPackageRuntime` writes
  (`'@pattern-stack/codegen/subsystems' → runtime/subsystems/index.ts`):

  ```
  src/modules/notes/use-cases/base-form.ts(2,27): error TS2724: '"@pattern-stack/codegen/subsystems"' has no exported member named 'TypedEventBus'. Did you mean 'TYPED_EVENT_BUS'?
  ```

  The two-line form this spec emits (`TYPED_EVENT_BUS` from the barrel, `TypedEventBus` from
  `../../../generated/events/bus`) compiled clean in the same probe.
- **Sites.** Five template sites, all reading `eventsTokenImport`: `create.ejs.t` L12 (EAV branch) and L90,
  `update.ejs.t` L12 (EAV branch) and L90, `delete.ejs.t` L11. No other template or emitter imports the class:
  `change-emitter-emission-generator.ts` imports only the token and types the bus structurally.
- **Dead local.** `typedEventBusImport` in `runtimeImportLocals` (`src/config/runtime-mode.mjs` L89) is read by no
  template.
- **Where the bus is written.** `entity new` always runs event codegen, in both modes and whether or not the events
  subsystem is installed (`src/cli/commands/entity.ts` L348-351, L665-688). In package mode the bus is written to
  `<paths.generated>/events/bus.ts`. In vendored mode it is written to `<subsystems_root>/events/generated/bus.ts`,
  which `@shared/subsystems/events` re-exports (`runtime/subsystems/events/index.ts` L37). Vendored mode is correct
  today.
- **TS twin.** `src/cli/shared/runtime-import.ts` has no `runtimeImportLocals` and no events entry. Nothing in it
  changes.

## Decision

The token comes from the package. The class comes from the project's generated bus. The class specifier is computed
in `entity-locals.js` next to `relationsImport` / `apiIncludesImport`, from the same `generatedDir`, relative to the
folder the use case is written into.

- **Not in `runtimeImportLocals`.** That table is keyed by mode only, and this specifier also depends on the
  entity's module folder (`context:`, `paths.modules_dir`) and on `paths.generated`. The table keeps
  `eventsTokenImport`, which is a mode-only runtime specifier. The dead `typedEventBusImport` entry is **deleted**
  from the table. Its name moves to the backend locals, where its value is correct.
- **Vendored stays byte-identical.** In vendored mode both specifiers are `@shared/subsystems/events`, and the
  templates emit the single combined line they emit today. They emit two lines only when the specifiers differ. Two
  imports from one module would change every vendored snapshot and trip `import/no-duplicates` in a host's lint.
  `just test-baseline` proves the vendored output did not move.
- **A value import, never `import type`.** `TypedEventBus` is the type of a decorated constructor parameter. Under
  `emitDecoratorMetadata` it is referenced at runtime in `design:paramtypes`, and with `isolatedModules` an
  `import type` there is TS1272. The vendored line is a value import today, and the new line is one too.

## Emitted shapes

`contact`, default layout, package mode, file `src/modules/contacts/use-cases/create-contact.use-case.ts`:

```ts
import { Injectable, Inject } from '@nestjs/common';
import { DRIZZLE } from '@pattern-stack/codegen/runtime/constants/tokens';
import type { DrizzleClient } from '@pattern-stack/codegen/runtime/types/drizzle';
import { TYPED_EVENT_BUS } from '@pattern-stack/codegen/subsystems';
import { TypedEventBus } from '../../../generated/events/bus';
import { tryGetRequester } from '@pattern-stack/codegen/runtime/base-classes/tenant-context';
```

`journal_entry` with `context: accounting`, under the junction smoke's custom layout
(`paths.modules_dir: apps/backend/src/domain`, `paths.generated: apps/backend/src/codegen`), package mode, file
`apps/backend/src/domain/accounting/journal-entries/use-cases/update-journal-entry.use-case.ts`:

```ts
import { TYPED_EVENT_BUS } from '@pattern-stack/codegen/subsystems';
import { TypedEventBus } from '../../../../codegen/events/bus';
```

Vendored mode, any layout. This is today's line, unchanged:

```ts
import { TYPED_EVENT_BUS, TypedEventBus } from '@shared/subsystems/events';
```

Everything else in the three files is unchanged.

## Interfaces

### `entity-locals.js`: one new backend local

```ts
// Returned from buildBackendLocals beside relationsImport / apiIncludesImport.
typedEventBusImport: string
//   vendored → subsystemsImport('vendored', 'events')   // '@shared/subsystems/events'
//   package  → relativeFrom(useCasesDir, `${generatedDirRel}/events/bus`)
//              // e.g. '../../../generated/events/bus'
```

Pseudocode (no implementation here):

```
import { rewriteSharedImport, subsystemsImport } from '../../../../src/config/runtime-mode.mjs'

relativeFrom(fromDir, target)          // the existing relativeFromModule closure, given its `from` dir:
  spec = posix.relative(normalize(fromDir), normalize(target))
  return spec starts with '.' ? spec : './' + spec
relativeFromModule = (t) => relativeFrom(moduleDir, t)    // relationsImport / apiIncludesImport unchanged

useCasesDir = `${moduleDir}/use-cases`  // one value; the use-case outputPaths entries use it too

typedEventBusImport =
  runtimeMode === 'vendored'
    ? subsystemsImport('vendored', 'events')
    : relativeFrom(useCasesDir, `${generatedDirRel}/events/bus`)
```

- `runtimeMode` is read at L1594, after the `apiIncludesImport` block (L1512-1521). Either hoist that read above
  the block or compute the new local after L1594. The specifier must not read `baseLocals.runtimeMode` a second
  time.
- `useCasesDir` replaces the `${moduleDir}/use-cases` literal in every `outputPaths` use-case entry (L1962-1992).
  The specifier and the files it is written into then derive from one value, and the output paths are
  byte-identical.
- `prompt.js` needs no change. `buildBackendLocals` already receives `runtimeMode` and `generatedDir` in its explicit
  key list (L381-396), and `...backendLocals` is spread last (L636). Because that call takes a key list and not a
  spread (CLAUDE.md), the custom-layout smoke is what proves `generatedDir` actually arrives: without it the import
  would point at `src/generated/events/bus`, which does not exist in that layout (TS2307).

### `runtimeImportLocals` (`src/config/runtime-mode.mjs`)

- Delete `typedEventBusImport`.
- Keep `eventsTokenImport`. Rewrite its comment: it is the specifier of the **token**. The class is the project's
  generated bus, and its specifier depends on the module folder, so `entity-locals.js` computes it.

### Templates: the five sites

Replace each `import { TYPED_EVENT_BUS, TypedEventBus } from '<%= eventsTokenImport %>';` with:

```
<% if (typedEventBusImport === eventsTokenImport) { -%>
import { TYPED_EVENT_BUS, TypedEventBus } from '<%= eventsTokenImport %>';
<% } else { -%>
import { TYPED_EVENT_BUS } from '<%= eventsTokenImport %>';
import { TypedEventBus } from '<%= typedEventBusImport %>';
<% } -%>
```

The sites are `create.ejs.t` L12 and L90, `update.ejs.t` L12 and L90, and `delete.ejs.t` L11. Both locals are
referenced unguarded (#638).

## Files

| File | Action | Purpose |
|---|---|---|
| `templates/entity/new/backend/entity-locals.js` | modify | `relativeFrom`, `useCasesDir`, `typedEventBusImport` (returned beside `apiIncludesImport`); import `subsystemsImport` |
| `templates/entity/new/backend/use-cases/create.ejs.t` | modify | L12, L90 → the import block above |
| `templates/entity/new/backend/use-cases/update.ejs.t` | modify | L12, L90 → the import block above |
| `templates/entity/new/backend/use-cases/delete.ejs.t` | modify | L11 → the import block above |
| `src/config/runtime-mode.mjs` | modify | delete `typedEventBusImport`; correct the `eventsTokenImport` comment |
| `src/cli/shared/runtime-import.ts` | none | the twin has no `runtimeImportLocals`, so there is nothing to sync. Said here so the reviewer does not look for it |
| `runtime/subsystems/index.ts` | modify (comment only) | L15-25: name the generated write use cases as the second consumer of the token-only export (#814): they take the token here and the class from `<paths.generated>/events/bus`. Add "do not re-export the class here" |
| `src/__tests__/templates/emits-rendering.test.ts` | modify | locals from `buildBackendLocals` (not hand-built); package-mode cases for all five sites; a layout + `context:` case; vendored cases for update and delete |
| `test/junction/_helpers.ts` | modify | custom layout writes the `journal_entry` `emits:` fixture; export its descriptor |
| `test/smoke/run-smoke-junction.ts` | modify | `assertTypedEventBusImports` on the custom-layout legs; header comment names #814 |
| `justfile` | modify (comment) | `test-smoke-junction` comment: the custom legs also compile an `emits:` entity's write use cases in both modes (#814) |
| `docs/specs/EVT-7.md` | modify | dated revision note on decision 4: in package mode the token comes from the barrel and the class from `<paths.generated>/events/bus` |
| `.claude/skills/events/event-codegen.md` | modify | § "Entity `emits:` block": drop the stale "Phase C design, not yet shipped"; give the generated import per mode. § "Generated artifacts": package mode writes them to `<paths.generated>/events/` |
| `consumer-skills/events/typed-bus-and-outbox.md` | modify | after the first code block, a package-mode note: the barrel exports the token only, so import the class from your generated bus |
| `docs/consumer/events.md` | modify | the same note at the L103 example |
| `consumer-skills/codegen/SKILL.md` | modify | `package` bullet (L44-46): project-specific generated code, such as the typed event bus, comes from `<paths.generated>`, never from the package |

No baseline or junction snapshot changes. If one does change, the vendored-unchanged invariant is broken and the
change is a bug.

## Tests and gates

### Subject gate 1: `just test-smoke-junction`, custom-layout legs (both modes), in `test-all`

**Why this smoke.** The plan offered the junction smoke or the capability smoke. The junction smoke's
`--layout custom` legs are the only legs in `test-all` that (1) run `subsystem install events` in **both** modes, so
the vendored leg can resolve `@shared/subsystems/events` (the default layout installs no events, and an `emits:`
fixture there would fail the vendored leg with TS2307 for a reason unrelated to #814); (2) move `paths.generated`
**and** `paths.modules_dir`, so the relative specifier is checked against the configuration the generator reads
(CLAUDE.md gate rule (b)); and (3) boot the AppModule afterwards, which also proves `TYPED_EVENT_BUS` resolves to
the project's class for these providers. The capability smoke installs no events and has no non-default layout.

**Fixture** (`test/junction/_helpers.ts`, custom layout only, written beside `LEDGER_YAML` and in the same way):
export `CUSTOM_LAYOUT_EMITS_ENTITY = { entity: 'journal_entry', plural: 'journal_entries', context: 'accounting' }`
and write this YAML into `<paths.entities>/journal_entry.yaml`:

```yaml
# #814 custom-layout smoke fixture: an `emits:` entity in a `context:` folder.
entity:
  name: journal_entry
  plural: journal_entries
  table: journal_entries
  context: accounting

fields:
  title:
    type: string
    required: true

behaviors:
  - timestamps

emits:
  - journal_entry_created
  - journal_entry_updated
  - journal_entry_deleted

events:
  - name: journal_entry_created
    queue: domain-events
    body:
      journal_entry_id: uuid
      title: string
  - name: journal_entry_updated
    queue: domain-events
    body:
      journal_entry_id: uuid
      title: string
  - name: journal_entry_deleted
    queue: domain-events
    body:
      journal_entry_id: uuid
      title: string
```

- Events are declared **inline** rather than as `events/*.yaml` files. The fixture is then one file, and the import
  under test does not depend on where the events are declared. The inline desugar gives `direction: change` and
  `aggregate: journal_entry`, which `validateEntityEmits` requires. `queue:` is required by the schema and ignored
  by the desugar.
- The payload is limited to `<entity>_id` (prompt.js rule 1 → `entity.id`) and an entity field (rule 3 →
  `entity.title`), because both resolve in all three bodies. See "Found while specifying" for the rules that do not.
- `context: accounting` adds one `../` that a specifier computed from `paths.modules_dir` would miss.

**Assertion** `assertTypedEventBusImports(projectDir, runtime)` runs in step 9 when `layoutArg === 'custom'`. All
paths come from `P` and the fixture descriptor, never from defaults. For each op (`create`, `update`, `delete`):

1. The file `${P.modules}/accounting/${emittedDir('journal_entries')}/use-cases/${emittedStem(op, 'journal_entry')}.use-case.ts`
   exists and contains `this.typedEvents.publish(` and `'journal_entry_${op}d'`. **This is what makes an absent
   input fail** (rule (c)). If the emits path silently stops rendering, the files fall back to the one-line delegate,
   which compiles. Without this check the gate would pass.
2. **package:** it contains `import { TYPED_EVENT_BUS } from '@pattern-stack/codegen/subsystems';` and
   `import { TypedEventBus } from '<rel>';`, where the harness computes
   `rel = path.posix.relative(<use-cases dir>, `${P.generated}/events/bus`)`. `${P.generated}/events/bus.ts` exists,
   and `${P.generated}/events/types.ts` declares `'journal_entry_created'`.
   **vendored:** it contains `import { TYPED_EVENT_BUS, TypedEventBus } from '@shared/subsystems/events';`.
3. **Both modes:** no file in it imports `TypedEventBus` from `@pattern-stack/codegen/subsystems`
   (`assertAbsent`, regex `/import \{[^}]*\bTypedEventBus\b[^}]*\} from '@pattern-stack\/codegen\/subsystems'/`).
   This pins the specifier. An import from `@pattern-stack/codegen/runtime/subsystems/events/index` would resolve to
   the package's own class, which is the wrong class even in a case where it compiled.

**Fails on its subject at a8629dfc.** With only the fixture and assertion applied, the package custom leg fails at
step 8 (`tsc`) with TS2724 once in each of the three use-case files. Those files are inside the generated project,
so `_consumer-errors.ts` counts them. The probe above reproduces the exact diagnostic. The vendored custom leg passes
at base: it is the control, and it shows that the fixture itself is sound. **The implementer runs
`bun test/smoke/run-smoke-junction.ts --scenario junction --runtime package --layout custom` on the base with only
the test changes applied, and pastes the three TS2724 lines into the PR body** before the generator change lands.

### Subject gate 2: `just test-unit` (`src/__tests__/templates/emits-rendering.test.ts`)

Locals come from `buildBackendLocals(definition, withEntities({ runtimeMode, … }))`, with the prompt-owned EVT-7
descriptors (`hasEmits`, `<op>EventType`) overlaid. The current hand-built `base()` would need a hand-written
`typedEventBusImport`, which is exactly the test-only fallback #638 removed. Cases:

- **package, default layout, table over the five sites** (`create` non-EAV, `create` EAV, `update` non-EAV, `update`
  EAV, `delete`). Each output contains
  `import { TYPED_EVENT_BUS } from '@pattern-stack/codegen/subsystems';` and
  `import { TypedEventBus } from '../../../generated/events/bus';`, and does not contain
  `TypedEventBus } from '@pattern-stack/codegen/subsystems'`. The EAV rows use `eav: true`. `withEntities` already
  names the `field_value` target.
- **package, custom layout + `context:`** (`modulesDir: 'apps/backend/src/domain'`,
  `generatedDir: 'apps/backend/src/codegen'`, `context: 'accounting'`): `locals.typedEventBusImport` is
  `'../../../../codegen/events/bus'`, and the create output carries it.
- **vendored, three ops:** each output contains the single combined `@shared/subsystems/events` line and no second
  `TypedEventBus` import. Today only create asserts this.
- The existing non-emits and transaction-body assertions are kept as they are.

**Fails on its subject at a8629dfc:** `buildBackendLocals` returns no `typedEventBusImport` there, so the package
rows render the combined barrel line and the `toContain('…/generated/events/bus')` assertions fail. The
custom-layout case also fails, because the value it reads comes from `runtimeImportLocals('package')`, which is
`'@pattern-stack/codegen/subsystems'`.

### Regression gates (cannot fail on #814's subject, by design)

- `just test-baseline`: vendored, so snapshots must be **byte-identical**. A diff means the template conditional or
  `useCasesDir` changed vendored output.
- `just test-junction`: default-layout snapshots, not touched by the custom-only fixture.
- `just test-smoke-capability`: package-mode compile of a non-emits tree. It is unaffected and stays in `test-all`.
- `just typecheck`.
- `src/__tests__/backend/strict-locals.test.ts` keeps passing unchanged. `typedEventBusImport` is always a string,
  so `assertNoUndefinedLocals` accepts it.

## Implementation steps

1. **Gate first** (`test/junction/_helpers.ts`, `test/smoke/run-smoke-junction.ts`, `emits-rendering.test.ts`).
   Add the fixture, the assertion and the unit cases. Run the package custom leg and the unit file on the base, and
   record the failures (TS2724 ×3; the unit assertions).
2. **Locals** (`entity-locals.js`): `relativeFrom`, `useCasesDir`, `typedEventBusImport`, and the
   `subsystemsImport` import.
3. **Table** (`runtime-mode.mjs`): delete `typedEventBusImport` and fix the comment.
4. **Templates**: the five sites.
5. **Gates green**: `just test-unit`, `just test-baseline` (byte-identical), all four `just test-smoke-junction`
   legs, `just typecheck`.
6. **Docs**: the comment in `runtime/subsystems/index.ts`, the EVT-7 revision note, the events skill, the two
   consumer event docs, the codegen consumer skill and the justfile comment.
7. Update this spec with what the build found.

## Risks

- **First compile of the update and delete emits bodies anywhere.** The baseline compiles only the create body. If
  the custom leg reports a diagnostic in those files that is not about the import, it is in scope: #814's "Done
  when" is that the three use cases pass `tsc`. Fix it in this PR and record it under "Found during
  implementation". Never narrow the assertion or the fixture to get around it (charter I9).
- **Boot.** The custom legs boot the AppModule with `SUBSYSTEM_MODULES` spread in, which includes
  `EventsModule.forRoot` (and `typedBus: TypedEventBus` in package mode). A DI failure in the new providers would
  show up there. That is in scope for the same reason.

## Found while specifying (not in scope)

- **Payload rules can name a `dto` that does not exist.** In `templates/entity/new/prompt.js` L538-555, rule 2
  (`created_by` / `updated_by` → `dto.<key>`) and rule 4 (`dto.<key>` fallback) are applied the same way to all
  three ops. `delete.ejs.t` has no `dto` in scope, so either rule gives TS2304 there. In `update.ejs.t`, `dto` is the
  partial update DTO, so `dto.<key>` is `T | undefined` against a `T` payload field. The #814 fixture keeps clear of
  both. This needs its own issue under the batch's follow-ups; it is not filed by this spec.

## Changelog

The PR body carries this block (see `changelog_policy` in the plan):

```
Changelog:
### Fixed
- **Package mode: the write use cases of an `emits:` entity compile (#814).** The create, update and delete use
  cases imported `TypedEventBus` from `@pattern-stack/codegen/subsystems`, which exports only the `TYPED_EVENT_BUS`
  token, so every `emits:` entity failed `tsc` with TS2724 under `runtime: package`. The token still comes from the
  package. The class now comes from the project's own generated bus, `<paths.generated>/events/bus`, by a path
  relative to the use case, and it is the class `EventsModule.forRoot({ typedBus })` binds to the token. Vendored
  output is unchanged.
  Upgrade: regenerate (`codegen entity new --all --force`) and drop any post-generate rewrite of this import.
```
