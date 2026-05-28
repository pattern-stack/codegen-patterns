---
name: codegen
description: >-
  Load when working in a project that uses @pattern-stack/codegen to scaffold a
  NestJS + Drizzle backend from YAML — i.e. when the request is to add or change
  an entity / module / CRUD resource, generate code from `entities/*.yaml`, run
  the `codegen` (aka `cdp`) CLI, install or wire an infrastructure subsystem, or
  refresh the project after a package upgrade. This is the entry-point router;
  it points at the focused `entities`, `subsystems`, `jobs`, `events`, `bridge`,
  and `sync` skills for deep work.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: false
---

<!-- managed by @pattern-stack/codegen — re-run `codegen skills install` to refresh. Edit the package source, not this vendored copy. -->

# Using @pattern-stack/codegen in this project

This project generates its backend (domain entities, repositories, services,
controllers, DTOs, use cases, Drizzle schemas, NestJS modules) from YAML entity
definitions, following Clean Architecture. You author small YAML files and run
the `codegen` CLI; the generator owns a few directories and never touches the
rest of your app.

The CLI binary is `codegen` (alias `cdp`). Every noun supports `--json` for
machine-readable output and `--cwd <path>` to target another project root.

## Mental model

- **You own**: `entities/*.yaml`, `events/*.yaml`, `app.module.ts`, `main.ts`,
  `database.module.ts`, `codegen.config.yaml`, and your hand-written use cases /
  adapters.
- **Codegen owns** (don't hand-edit — regenerated every run):
  - `src/generated/modules.ts` — the `GENERATED_MODULES` barrel
  - `src/generated/schema.ts` — the Drizzle schema barrel
  - the per-entity module tree (`src/modules/<plural>/…` in clean-lite-ps)
- **The package vendors** managed copies of its runtime into `src/shared/**`
  (base classes, types, the `DRIZZLE` token, the Zod pipe, the OpenAPI
  registry) and installed subsystems into `<subsystems-root>/<name>/`. Treat
  these as generated output: don't hand-edit; subclass instead. `codegen
  update` refreshes them after a package bump.

The generation pipeline: `YAML → parse → analyze → templates → code`. After any
generation run the two barrels are rewritten and you wire them into
`app.module.ts` exactly once — codegen never edits that file again.

## Routing — load the focused skill for deep work

| Task | Read |
|---|---|
| Author / change an entity YAML (fields, families, queries, EAV, relationships) | the `entities` skill |
| Install or wire an infrastructure subsystem; get the `forRoot` registration order right | the `subsystems` skill |
| Write a background `@JobHandler`, configure pools, set concurrency/ordering | the `jobs` skill |
| Author a domain event, publish via the outbox, use the typed event bus | the `events` skill |
| React to an event with a durable async job (the event-to-job bridge) | the `bridge` skill |
| Pull/push data from an external system (`IChangeSource` / `ISyncSink`) | the `sync` skill |

## CLI quick reference

```bash
# Project lifecycle
codegen init                       # scaffold this project's shared layer + config + skills
codegen project scan               # detect framework/ORM/architecture → propose config
codegen project config             # print the resolved codegen.config.yaml
codegen update                     # re-sync vendored runtime + subsystems + skills after a package bump

# Entities
codegen entity new entities/<file>.yaml   # generate one entity
codegen entity new --all                  # regenerate every entity in entities/
codegen entity new --all --dry-run        # preview
codegen entity list                       # tabular list
codegen entity validate --strict          # validate YAML + cross-refs (warnings fail)

# Subsystems (see the `subsystems` skill for wiring + order)
codegen subsystem                  # summary: installed vs available
codegen subsystem install <name>   # vendor a subsystem's runtime + inject its config block
codegen subsystem list

# Skills
codegen skills install             # (re)vendor these consumer skills into .claude/skills
codegen skills list
```

## Non-obvious rules

- **YAML is `snake_case`; generated TS properties are `camelCase`.** The
  templates derive `accountId` from `account_id`. Entity names are singular
  `snake_case` (`opportunity`).
- **Two architectures, mutually exclusive.** `generate.architecture` in
  `codegen.config.yaml` is either `clean-lite-ps` (the supported consumer
  default — lighter per-entity module layout) or `clean` (full split). Don't mix.
- **Barrels are wired once.** After the first `entity new`, add
  `...GENERATED_MODULES` to `app.module.ts` and `export * from
  './generated/schema'` to your schema root. Codegen keeps the barrel contents
  fresh; you never re-touch `app.module.ts` for new entities.
- **Migrations are not `drizzle-kit push` in shared/CI/prod.** Generate
  reviewable SQL with Atlas (`atlas migrate diff` → review → `atlas migrate
  apply`). `push` is dev-loop-only.
- **Upgrades need a re-sync.** After `bun add @pattern-stack/codegen@latest`, run
  `codegen update` — the vendored `src/shared/**` and installed subsystems are
  otherwise stale against the new package.

## Do not

- **Do not hand-edit anything under `src/generated/`** or the vendored
  `src/shared/**` runtime files — the next `entity new` / `codegen update`
  overwrites them. Need different behavior? Subclass the base in your own module.
- **Do not declare a fresh `DRIZZLE` token.** Import the one from
  `@shared/constants/tokens`; a second token has a different identity and DI
  won't resolve.
- **Do not add tables directly to `src/generated/schema.ts`.** Hand-authored
  tables go in your own file and are combined in the schema root re-export.
- **Do not reach for `clean` vs `clean-lite-ps` arbitrarily.** Match the
  project's existing `generate.architecture`; switching mid-project rewrites the
  whole module layout.
