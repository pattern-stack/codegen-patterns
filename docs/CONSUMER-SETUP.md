# Consumer Setup

The contract a consumer project must satisfy for generated code to compile and run. If you just want to generate a first entity in this repo, read [GETTING-STARTED.md](./GETTING-STARTED.md) instead — this doc is for the second step: wiring `@anthropic/codegen` into a separate NestJS + Drizzle project you own.

A complete working example lives at [`codegen-pattern-demo-app/`](https://github.com/anthropics/codegen-pattern-demo-app) — every file referenced below has a real counterpart there.

## Who this is for

You are running `@anthropic/codegen` (installed as a sibling repo, workspace dep, or `npx @anthropic/codegen` binary — see [ADR-015](./adrs/ADR-015-cli-command-architecture.md)) against your own NestJS application. Generated code imports from `@shared/*` path aliases and injects a `DRIZZLE` token. This doc tells you what those import paths and tokens must resolve to.

## Prerequisites

- **Bun** 1.0+ or **Node** 20+
- **NestJS** 10+
- **Drizzle ORM** (currently `drizzle-orm@^0.30`; see [Troubleshooting](#troubleshooting) for the 0.45 caveat)
- **TypeScript** 5+ with `"strict": true` and decorator metadata enabled
- A running Postgres you can point at with a `DATABASE_URL`

## Project structure expected

Minimum layout the generator writes into and reads from:

```
<project-root>/
├── codegen.config.yaml            # generator config
├── tsconfig.json                  # must declare @shared/* and @modules/*
├── schema.ts                      # one-line re-export of generated schema barrel
├── drizzle.config.ts              # Drizzle Kit config (migrations)
├── entities/                      # your YAML entity definitions (input)
│   └── account.yaml
├── modules/                       # clean-lite-ps output lands here
│   └── accounts/
├── shared/                        # thin re-export shims (authored once)
│   ├── base-classes/
│   ├── constants/tokens.ts
│   ├── database/database.module.ts
│   └── types/drizzle.ts
└── src/
    ├── app.module.ts              # you author; wires DatabaseModule + GENERATED_MODULES
    ├── main.ts
    └── generated/                 # codegen owns this tree — don't edit
        ├── modules.ts             # GENERATED_MODULES barrel
        └── schema.ts              # Drizzle schema barrel
```

Only three paths are codegen-owned: `src/generated/*`, the per-entity `modules/<plural>/` tree (clean-lite-ps), and whatever lands under `backend_src/` (full clean). Everything else is yours.

## tsconfig path aliases

Generated code imports from `@shared/*` and `@modules/*`. Your `tsconfig.json` must declare both:

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["./shared/*"],
      "@modules/*": ["./modules/*"]
    }
  },
  "include": [
    "src/**/*",
    "shared/**/*",
    "modules/**/*",
    "schema.ts",
    "drizzle.config.ts"
  ]
}
```

`@generated/*` is not currently a required alias — generated code imports from its own tree via relative paths. If you plan to reference the barrels from application code (e.g. `@generated/modules`), add `"@generated/*": ["./src/generated/*"]`.

## `DatabaseModule` contract

Every generated repository expects the `DRIZZLE` injection token to resolve to a Drizzle client. A `@Global()` `DatabaseModule` is the standard way to satisfy that. Minimum viable scaffold — author this once:

```ts
// shared/database/database.module.ts
import { Module, Global } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../../schema';
import { DRIZZLE } from '../constants/tokens';

export { DRIZZLE };
export type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;

/**
 * DatabaseModule — provides the DRIZZLE injection token globally.
 * Import once in AppModule, before any generated module.
 */
@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      useFactory: () => {
        const pool = new Pool({
          connectionString: process.env.DATABASE_URL,
        });
        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
```

Requirements the generator relies on:

1. **`@Global()`** — generated repositories don't import `DatabaseModule` themselves; they inject `DRIZZLE` directly. Only a global provider satisfies that.
2. **Provides `DRIZZLE`** — must use the exact token re-exported from `@shared/constants/tokens`.
3. **Exports `DRIZZLE`** — so other modules can consume it.
4. **Client constructed with full schema** — `drizzle(pool, { schema })` where `schema` is `export * from './generated/schema'`. Passing the schema object enables typed relational queries.

## `DRIZZLE` injection token

Generated repositories do this:

```ts
constructor(@Inject(DRIZZLE) db: DrizzleClient) { super(db); }
```

`DRIZZLE` resolves to `@shared/constants/tokens`, which is a re-export of `codegen-patterns/runtime/constants/tokens`. The value is the string literal `'DRIZZLE'`. Do not declare a fresh token in your project — it must be the same identity as the runtime's, or `useFactory` will bind to one symbol and `@Inject()` will look for another.

## `shared/` re-export shims

Generated code imports from stable `@shared/*` paths. Those paths have to resolve to something — the "something" is a set of thin files in your `shared/` tree that re-export from `codegen-patterns/runtime/`. The shims exist so:

- The generator can emit stable imports without knowing where the consumer installed the runtime.
- Consumers can later swap the runtime location (workspace dep, published package) without rewriting generated code.
- See [ADR-017](./adrs/ADR-017-barrel-files-over-injects.md) for the broader "stable surface over inject" philosophy these shims extend.

Enumerate every shim below. All paths are relative to your project root. Adjust the `../../../codegen-patterns/runtime/...` path to wherever you've installed the runtime (sibling repo in the example; `../node_modules/@anthropic/codegen/runtime/...` for workspace installs).

### Base classes

```ts
// shared/base-classes/base-repository.ts
export * from '../../../codegen-patterns/runtime/base-classes/base-repository';
```

```ts
// shared/base-classes/base-service.ts
export * from '../../../codegen-patterns/runtime/base-classes/base-service';
```

```ts
// shared/base-classes/synced-entity-repository.ts
export * from '../../../codegen-patterns/runtime/base-classes/synced-entity-repository';
```

```ts
// shared/base-classes/synced-entity-service.ts
export * from '../../../codegen-patterns/runtime/base-classes/synced-entity-service';
```

```ts
// shared/base-classes/activity-entity-repository.ts
export * from '../../../codegen-patterns/runtime/base-classes/activity-entity-repository';
```

```ts
// shared/base-classes/activity-entity-service.ts
export * from '../../../codegen-patterns/runtime/base-classes/activity-entity-service';
```

```ts
// shared/base-classes/metadata-entity-repository.ts
export * from '../../../codegen-patterns/runtime/base-classes/metadata-entity-repository';
```

```ts
// shared/base-classes/metadata-entity-service.ts
export * from '../../../codegen-patterns/runtime/base-classes/metadata-entity-service';
```

```ts
// shared/base-classes/knowledge-entity-repository.ts
export * from '../../../codegen-patterns/runtime/base-classes/knowledge-entity-repository';
```

```ts
// shared/base-classes/knowledge-entity-service.ts
export * from '../../../codegen-patterns/runtime/base-classes/knowledge-entity-service';
```

```ts
// shared/base-classes/with-analytics.ts
export { WithAnalytics } from '../../../codegen-patterns/runtime/base-classes/with-analytics';
```

You only need a shim for the families your entities actually use. If no YAML declares `family: knowledge`, skip the knowledge shims. Adding a shim later costs one file and one line.

### Constants

```ts
// shared/constants/tokens.ts
export { DRIZZLE } from '../../../codegen-patterns/runtime/constants/tokens';
```

### Types

```ts
// shared/types/drizzle.ts
export type { DrizzleClient } from '../../../codegen-patterns/runtime/types/drizzle';
```

## `schema.ts` wiring

Drizzle Kit and the `DatabaseModule` both need a single entry point for the schema. That entry point is a one-line re-export of the generated barrel:

```ts
// schema.ts
export * from './src/generated/schema';
```

The generator writes `src/generated/schema.ts` on every run — do not edit it, do not include additional tables there. If you have hand-authored tables outside the codegen entity set, `schema.ts` can combine both:

```ts
export * from './src/generated/schema';
export * from './shared/database/auth-tables'; // hand-authored
```

## `app.module.ts` wiring

`AppModule` imports the `DatabaseModule` first, then spreads the generated module barrel:

```ts
// src/app.module.ts
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../shared/database/database.module';
import { GENERATED_MODULES } from './generated/modules';

@Module({
  imports: [DatabaseModule, ...GENERATED_MODULES],
})
export class AppModule {}
```

`DatabaseModule` must come before `GENERATED_MODULES` so the `DRIZZLE` provider exists when generated modules instantiate. Any non-codegen modules you author (`AuthModule`, `HealthModule`) go in the same `imports:` array — the barrel is additive, not exclusive. See [ADR-017](./adrs/ADR-017-barrel-files-over-injects.md) for why codegen writes a barrel instead of mutating this file.

## `codegen.config.yaml`

Minimum viable config for a backend-only clean-lite-ps project:

```yaml
# codegen.config.yaml

paths:
  backend_src: .                    # root-relative; clean-lite-ps writes to modules/<plural>/
  entities_dir: entities
  generated: src/generated          # ADR-017 barrels land here

generate:
  architecture: clean-lite-ps       # clean | clean-lite-ps
  frontend: false                   # emit Electric-SQL frontend pipeline?
  commands: true
  queries: true

naming:
  fileCase: kebab-case              # kebab-case | PascalCase | camelCase | snake_case
  suffixStyle: dotted               # dotted (.entity.ts) | suffixed (Entity.ts)
  terminology:
    command: use-case
    query: use-case

database:
  dialect: postgres
```

`paths.generated` must sit inside your `tsconfig.json` `"include"` globs — otherwise TS won't typecheck the barrel.

## Verification

After authoring the shims, `DatabaseModule`, `schema.ts`, `app.module.ts`, and `codegen.config.yaml`:

```bash
# Regenerate the full entity set
bun /path/to/codegen-patterns/src/cli/index.ts entity new --all
# (or `just gen-all` / `npx @anthropic/codegen entity new --all` depending on install form)

# Typecheck — zero errors expected
bun run typecheck
# or: bunx tsc --noEmit
```

If typecheck is clean, the contract is satisfied. If there are errors, they'll almost always trace to one of the causes below.

## Troubleshooting

### `Cannot find module '@shared/constants/tokens'` (or any `@shared/*` path)

The `@shared/*` alias is missing from `tsconfig.json` `compilerOptions.paths`, or the shim file at the aliased location doesn't exist. Re-check the [shims list](#shared-re-export-shims) and the [path aliases block](#tsconfig-path-aliases).

### `Nest can't resolve dependencies of the <X>Repository (?)`

The `DRIZZLE` token isn't being provided. Either `DatabaseModule` isn't imported in `AppModule`, isn't `@Global()`, or you've declared a second `DRIZZLE` constant locally that shadows the runtime one. The token must be re-exported from `@shared/constants/tokens` (see above), not redefined.

### `AUTO-GENERATED` barrels never appear in `src/generated/`

You're likely using the legacy CLI (`bun src/cli.ts entity entities/foo.yaml`), which doesn't regenerate barrels. Use the noun-verb CLI: `codegen entity new --all` (or `src/cli/index.ts entity new --all`). See `DOGFOOD-LOG.md` entry about "Barrels are only regenerated by the noun-verb CLI".

### `Cannot find module 'config/paths.mjs'` when invoking the CLI

Stale import in `templates/entity/new/prompt.js`; fixed upstream. Update your `codegen-patterns` checkout to a recent commit.

### `Error: I can't find action 'new' for generator 'entity'`

The CLI can't locate its templates dir. Default path resolves relative to the CLI's own file — if you're invoking from outside the `codegen-patterns` repo, set:

```bash
export CODEGEN_TEMPLATES_DIR=/path/to/codegen-patterns/templates
```

### Type errors referencing `shouldInlineParams` or `PgColumn`

Two incompatible `drizzle-orm` versions in the resolved module graph. The generator's runtime base classes must typecheck against the same `drizzle-orm` version your generated entities do. Options:

1. Pin `drizzle-orm` to one version across consumer + runtime (workspace dedupe, or matching versions in two sibling repos).
2. Use `drizzle-orm@^0.30.x` for now — the runtime base classes aren't yet on the 0.45 API (tracked in `DOGFOOD-LOG.md`).

### `Types have separate declarations of a private property 'shouldInlineParams'`

You have two copies of drizzle-orm installed — one in your project and one in codegen-patterns. This happens when `shared/base-classes/*.ts` re-exports from `../../codegen-patterns/runtime/` via relative paths instead of containing vendored copies.

Fix: copy the runtime files into your project rather than re-exporting. Use `codegen init` to set up vendored copies, or copy `runtime/base-classes/` into `shared/base-classes/` manually. Each file should contain the actual code, not a `export * from '../../../codegen-patterns/runtime/...'` re-export.

### HTML-escaped entities in generated TypeScript (`&#39;` instead of `'`)

EJS template escape bug, fixed upstream. Pull the latest `codegen-patterns` and regenerate.

### Generator emits files outside `paths.generated`

It shouldn't — that's a bug. File an issue. The only files codegen writes are (a) per-entity module trees under your configured architecture and (b) the two barrels under `paths.generated`. If `app.module.ts` or a hand-authored file changed, something is wrong.

## References

- [ADR-017 — Barrel Files over Hygen Injects](./adrs/ADR-017-barrel-files-over-injects.md) — why `@shared/*` exists and why codegen never mutates your files
- [ADR-015 — CLI Command Architecture](./adrs/ADR-015-cli-command-architecture.md) — install forms and the noun-verb interface
- [ADR-005 — Entity Family Base Classes](./adrs/ADR-005-entity-family-base-classes.md) — which family shim you need per entity
- [GETTING-STARTED.md](./GETTING-STARTED.md) — entity YAML authoring and the generator lifecycle
