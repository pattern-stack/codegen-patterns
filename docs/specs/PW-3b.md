# PW-3b: each context's repository bundle, and `openapi.ts`, under `wiring: pattern-stack`

**Status:** implemented · **Follows:** PW-3a · **Next:** PW-3c (junctions on pattern-stack), PW-4 (`project init` for pattern-stack)

## Problem

d27 puts the platform's services at the **context** level: a hand-written context service over the generated data
layer. PW-3a composes one module per context, but a context service had nothing to take except the concrete
repository classes, and nothing registered the DTO schemas, which the Nest modules do in their constructors.

## Decision

### A repository port per entity, a bundle per context

- **`<Entity>RepositoryPort`**, in `<entity>.wiring.ts`: the repository class's public members, as a structural type
  (`{ [K in keyof ContactRepository]: ContactRepository[K] }`). Private and protected members drop out, so any
  object with the same public methods fits: a test's fake, or another backend's store.
- **`<Context>Repositories`**, in the context's `module.ts`: one key per entity, its port. The root module's is
  `EntitiesRepositories`.
- The composition checks the composed repositories against it:
  `repositories: { … } satisfies CrmRepositories`. The returned object keeps the concrete classes, because the
  services' constructors and other modules' compositions take those.
- The names come from `repositoryPortName`, `registerSchemasName` and `repositoriesBundleName` in
  `src/derived/api/names.ts`, which the template and the emitter call.
- A module's API keys each entity beside `repositories`, so an entity that camelCases to `repositories` is refused
  by name.
- `entity new <one>` re-renders only that entity's `.wiring.ts`, but the composition imports from every entity's. The
  CLI therefore names any entity whose `.wiring.ts` is missing, or lacks an export the composition imports (a file
  an older codegen wrote), and says to run `entity new --all` (`wiringFilesBehind`).

**Why a structural type, not a listed interface.** The API surface lists the generated repository methods, but not
`BaseRepository`'s own (`create`, `update`, `delete`, `exists`, `upsertMany`). A port built from the surface would
leave out the writes a context service needs. The class's own public type has them all and can't drift from it.

**What this port is not yet.** Its signatures are the Drizzle repository's: `tx?: DrizzleTx`, and list options typed
over the Drizzle table. A store for a second backend would need a transaction handle as a protocol type. That's the
crew lane's G7 / G11 (`PLAN-platform-lane.md`, "the transaction handle as a protocol type"). Until then, the port
names the context's dependencies and lets a test hand in a fake. When G11 lands, the port's signatures change and
its name stays.

### `<generated>/openapi.ts`

- Each `<entity>.wiring.ts` exports `register<Entity>Schemas(openApi)`. It registers the create DTO (unless the
  derivation removed the base's create, as the Nest module does), the update DTO and the output DTO.
- `<generated>/openapi.ts` exports `registerOpenApiSchemas(openApi)`, which calls every entity's. An HTTP layer
  (H-1), or a script that writes the document, calls it once before `openApi.build()`.
- It imports `OpenApiRegistry` from `openApiImport(mode)` (`src/cli/shared/runtime-import.ts`). That's a new TS twin of
  the templates' `openApiImport` local, and `nest-free.test.ts` holds the two equal. It is a twin, not an import of
  the `.mjs`, because no non-test file in `src` imports an `.mjs`. `runtime/shared/openapi` was
  already one of the Nest-free entries.
- Switching back to `wiring: nest` removes it with the other pattern-stack files (`stale-files.ts`).

## The gates

- `src/__tests__/emitters/composition/emit-composition.test.ts` plans the composition over the pattern-stack smoke's
  fixtures. It checks:
  - each context's bundle and the `satisfies` check;
  - `openapi.ts`'s imports and calls;
  - the `repositories` refusal;
  - `wiringFilesBehind`.
- `test-smoke-pattern-stack`:
  - expects `generated/openapi.ts`;
  - its usage file (`fixtures-pattern-stack-usage/crud-check.ts`) gains a context-service-shaped function that takes
    `CrmRepositories` and is called with `crm.repositories`;
  - it also gains `openApiCheck`, which:
    - registers every schema and builds the document;
    - checks the components;
    - fails on a dangling `$ref` (the Nest gate's own `_openapi-refs.ts`, copied in);
    - fails on a request DTO's example that its own schema rejects.
  The compile half type-checks both and runs `openApiCheck`, since it needs no database. The Postgres half runs
  both.

## Byte-identity

The Nest output doesn't change. Only the `patternStackWiring` branches of `wiring.ejs.t` and the pattern-stack-only emitter changed.
