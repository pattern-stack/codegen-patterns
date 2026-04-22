---
name: openapi
description: Load when working on OpenAPI/Swagger surfacing — anything under `runtime/shared/openapi/` (registry, tokens, error-response DTO), the `OPENAPI_REGISTRY` DI token, `@anatine/zod-openapi` peer-dep wiring, `@nestjs/swagger` decorator emission in controller templates, the `openapi:` block in `codegen.config.yaml`, the `/docs` + `/docs-json` routes, `SwaggerModule.setup()` in generated `main.ts`, the smoke test's programmatic `/docs-json` verification, or any reference to the OPENAPI-1..4 specs or issue #61.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: false
---

# OpenAPI Domain Skill

**Phase status:** Shipped 2026-04-22 via OPENAPI-1..4 (PRs #183, #185, #186, #TBD). No dedicated ADR exists — the epic is documented by `docs/specs/OPENAPI-PHASE-1-PLAN.md` plus per-PR specs `OPENAPI-1.md` … `OPENAPI-4.md`. Issue #61 is the motivating bug ("generated apps expose 34+ controllers with 0 component schemas"). Unblocks ADR-026 (observability-api needs a typed `/ops/*` surface).

The OpenAPI subsystem is a **cross-cutting documentation surface**, not a Protocol→Backend→Factory subsystem like events/jobs/cache/storage. The runtime is a single singleton class (`OpenApiRegistry`) consumed by every generated module. The "subsystem install" flow is config-only (`openapi-config`) — it injects a `codegen.config.yaml` block and prints next-step hints; the registry itself is vendored at `codegen project init` time.

## Mental model

**Registry-as-singleton, populated at module init, built once at boot.**

```
                         ┌─────────────────────────┐
  project init ─────────▶│ src/shared/openapi/*    │ vendored files
                         │   registry.ts           │ (OPENAPI-1)
                         │   registry.tokens.ts    │
                         │   error-response.dto.ts │
                         │   errors.ts / index.ts  │
                         └───────────┬─────────────┘
                                     │
                                     ▼
              ┌──────────────────────────────────────────────┐
              │ AppModule providers: [{ provide:             │
              │   OPENAPI_REGISTRY, useValue:                │
              │   new OpenApiRegistry() }]                   │ (OPENAPI-4)
              └──────────────────────────────────────────────┘
                                     │
                  @Inject(OPENAPI_REGISTRY)  every entity module
                                     │
                                     ▼
              ┌──────────────────────────────────────────────┐
              │ ContactsModule.onModuleInit() {              │
              │   openapi.registerSchema('CreateContactDto', │ (OPENAPI-2)
              │     createContactSchema);                    │
              │   openapi.registerSchema(...);               │
              │ }                                            │
              └──────────────────────────────────────────────┘
                                     │
                                     ▼
              ┌──────────────────────────────────────────────┐
              │ main.ts bootstrap:                           │
              │   const doc = await registry.build({...})    │ (OPENAPI-4)
              │   SwaggerModule.setup('/docs', app, doc)     │
              └──────────────────────────────────────────────┘
```

Controllers reference registered schemas by **string name** via
`@ApiBody({ schema: { $ref: '#/components/schemas/CreateContactDto' } })`
(OPENAPI-3) — they never pass a class reference because Zod-derived DTOs are
`type X = z.infer<...>` aliases, not runtime classes.

## Four locked decisions (epic-level)

1. **Library: `@anatine/zod-openapi`** (de facto standard). Lazy-imported as an
   optional peer — see `CubeAnalyticsBackend` precedent. Consumers that don't
   install the peer still boot; `build()` throws `OpenApiPeerDepMissingError`
   on first call.
2. **Swagger UI default path: `/docs`** (configurable via `openapi.path`).
   JSON spec at `<path>-json` — wired automatically by `SwaggerModule.setup`.
3. **Default security scheme: `BearerAuth`** (`type: http`, `scheme: bearer`,
   `bearerFormat: JWT`). Applied globally via `document.security = [{ bearer: [] }]`.
4. **OpenAPI version: 3.0.3.** 3.1 support deferred until Swagger UI tooling
   catches up.

## Routing table

| Task | Read |
|---|---|
| Epic plan + the four locked decisions + risks | `docs/specs/OPENAPI-PHASE-1-PLAN.md` |
| Per-PR specs (registry, DTO reg, controller decorators, bootstrap) | `docs/specs/OPENAPI-{1,2,3,4}.md` |
| Registry source + peer-dep lazy-load pattern | `runtime/shared/openapi/registry.ts` |
| Shared `ErrorResponseDto` shape + auto-registration | `runtime/shared/openapi/error-response.dto.ts` |
| How consumer projects get the registry | `src/cli/shared/init-scaffold.ts` (§`VENDORED_RUNTIME_FILES`) |
| `codegen subsystem install openapi-config` flow | `src/cli/commands/subsystem.ts` (`executeOpenApiConfig`) |
| CONSUMER-SETUP §OpenAPI — install + knobs + gotchas | `docs/CONSUMER-SETUP.md` |
| Smoke-test programmatic verification | `test/smoke/verify-openapi.ts` |
| Generated DTO + controller + module templates | `templates/entity/new/backend/`, `templates/entity/new/clean-lite-ps/` |

## Do not

- **Do not instantiate `new OpenApiRegistry()` outside `AppModule`.**
  The registry is singleton-per-process. Generated modules inject it via
  `@Inject(OPENAPI_REGISTRY)`; a forked instance forks the schema table and
  produces a partial `/docs-json`. If a test needs a clean registry, use
  `registry.reset()` (keeps the auto-registered `ErrorResponseDto` invariant).

- **Do not pass class references to `@ApiBody` / `@ApiResponse`.** Generated
  DTOs are Zod-derived `type X = z.infer<...>` aliases — TypeScript types,
  not runtime classes. `@ApiBody({ type: CreateContactDto })` is a compile
  error ("only refers to a type"). Use `schema: { $ref: '#/components/schemas/<Name>' }`
  and register the Zod schema by string name (OPENAPI-2 + OPENAPI-3).

- **Do not statically import `@anatine/zod-openapi`.** The peer is optional
  (in `peerDependenciesMeta`). `registry.ts` uses the computed-specifier
  dance (`const specifier: string = '@anatine/zod-openapi'; await
  import(specifier);`) so tsc doesn't hoist the import into the consumer's
  typecheck graph. New vendored files that reference the peer must follow
  the same pattern — never a literal `import { generateSchema } from
  '@anatine/zod-openapi'`.

- **Do not register the same schema name twice.** `registerSchema` throws
  `DuplicateSchemaError`. If two entities need similar shapes (e.g.
  `PaginationCursor`), prefix with the owner (`AccountPaginationCursor`).

- **Do not re-register `ErrorResponseDto`.** The registry constructor
  auto-registers it; `reset()` re-seeds it. Controllers' 4xx
  `@ApiResponse` decorators `$ref` it directly.

- **Do not try to make `@nestjs/swagger` conditional on
  `openapi.enabled`.** Generated controllers import decorator functions
  unconditionally at the top of the file (OPENAPI-3 implementation note 5).
  The peer dep must be installed whether or not Swagger UI mounts. A future
  ADR can add a `generate.openapi_decorators: false` codegen flag to opt
  out of decorator emission entirely.

- **Do not call `registry.build()` in a hot path.** It's async (the peer is
  lazy-imported on first call) and iterates every registered Zod schema.
  `main.ts` awaits it once at bootstrap; that's the only intended call
  site.

- **Do not route Swagger UI setup through per-entity modules.**
  `SwaggerModule.setup()` is a bootstrap concern; the generated modules'
  sole OpenAPI responsibility is `registerSchema` at `onModuleInit`. The
  flow is:  modules populate registry → `main.ts` reads registry once →
  `SwaggerModule` mounts the HTML + JSON routes.

## Current runtime snapshot (vendored into consumer `src/shared/openapi/`)

```
runtime/shared/openapi/
  registry.ts              # OpenApiRegistry class — lazy-loads peer,
                           # assembles OpenAPIObject (3.0.3), async build()
  registry.tokens.ts       # OPENAPI_REGISTRY string constant
  error-response.dto.ts    # ERROR_RESPONSE_SCHEMA_NAME + errorResponseSchema
                           # auto-registered in constructor + reset()
  errors.ts                # OpenApiPeerDepMissingError, DuplicateSchemaError
  index.ts                 # public barrel
```

All five files are listed in `src/cli/shared/init-scaffold.ts ::
VENDORED_RUNTIME_FILES` — they land in every new consumer project at
`src/shared/openapi/*` on `codegen project init`.

Templates that emit OpenAPI-aware code:

```
templates/entity/new/backend/dto.ejs.t       # exports Zod schemas + type aliases
templates/entity/new/backend/module.ejs.t    # @Inject(OPENAPI_REGISTRY), registerSchema in onModuleInit
templates/entity/new/backend/controller.ejs.t  # @Api* decorators on every method
templates/entity/new/clean-lite-ps/dto.ejs.t
templates/entity/new/clean-lite-ps/module.ejs.t
templates/entity/new/clean-lite-ps/controller.ejs.t
templates/subsystem/openapi-config/prompt.js
templates/subsystem/openapi-config/codegen-config-openapi-block.ejs.t
```

CLI additions:

```
src/cli/shared/subsystem-detect.ts      # 'openapi-config' in SubsystemName union + SUBSYSTEMS[]
src/cli/shared/config-block-detect.ts   # 'openapi' in SubsystemName union
src/cli/commands/subsystem.ts           # SubsystemInstallCommand.executeOpenApiConfig()
src/cli/shared/init-scaffold.ts         # OPENAPI_REGISTRY provider in appModuleContent();
                                        # mainTsContent() with conditional SwaggerModule.setup
```

Smoke verification:

```
test/smoke/run-smoke.ts                 # step 7 runs verify-openapi.ts
test/smoke/verify-openapi.ts            # programmatic AppModule import + registry.build()
                                        # asserts schemas, paths, security scheme
```

## Cross-links

- `docs/specs/OPENAPI-PHASE-1-PLAN.md` — epic orchestration + the four
  locked decisions.
- `docs/specs/OPENAPI-1.md` — registry + optional peer dep.
- `docs/specs/OPENAPI-2.md` — DTO schema registration at module init.
- `docs/specs/OPENAPI-3.md` — controller decorators (`@ApiOperation`,
  `@ApiBody`, `@ApiResponse`, `@ApiParam`, `@ApiBearerAuth`).
- `docs/specs/OPENAPI-4.md` — Swagger bootstrap + `openapi-config`.
- `docs/CONSUMER-SETUP.md` §OpenAPI — consumer-facing install + knobs +
  gotchas.
- Issue #61 (original bug: "/docs-json has 0 component schemas").
- ADR-026 / observability-api — downstream consumer of this surface.
