# OpenAPI + Swagger Phase 1 — Orchestration Plan

**Status:** Shipped 2026-04-22 via PRs #183 (OPENAPI-1), #185 (OPENAPI-2), #186 (OPENAPI-3), and #TBD (OPENAPI-4). Epic closed. #61 closed.
**Captured:** 2026-04-22
**Scope:** codegen-patterns library changes only. Wires `@anatine/zod-openapi` into generated NestJS apps so every controller ships a typed `/docs-json` + Swagger UI at `/docs`.
**Unblocks:** ADR-026 / observability plane Phase 1 (`observability-api` needs this for `/ops/*` controllers).
**Closes:** #61 (OpenAPI component schemas — bridge Zod DTOs into /docs-json).

## Post-ship notes

- `templates/project/main.ts.ejs.t` doesn't exist — `main.ts` + `app.module.ts` are emitted inline from `src/cli/shared/init-scaffold.ts`. OPENAPI-4 added `mainTsContent()` alongside `appModuleContent()`. See OPENAPI-4 Implementation Notes §1.
- `OpenApiModule` is an inline `@Global()` wrapper around the registry provider in the emitted `app.module.ts`. Plain AppModule-level providers don't reach imported feature modules — NestJS DI scoping rule. See OPENAPI-4 Implementation Notes §2.
- `main.ts` uses a two-pass document build: registry (schemas) + `SwaggerModule.createDocument` (paths) merged. See OPENAPI-4 Implementation Notes §3.
- Smoke test verifies `/docs-json` via programmatic `NestFactory.create()` + in-memory document build, not HTTP boot. ~300ms overhead on existing smoke. See OPENAPI-4 Implementation Notes §6.

---

## Context

Generated NestJS apps emit 34+ controller paths today but `/docs-json` has **0** component schemas — every request/response body is `{}` in the OpenAPI spec. Swagger UI renders paths without payload detail. This epic adopts `@anatine/zod-openapi`, registers Zod schemas from generated DTOs at module init, decorates controllers with `@ApiOperation`/`@ApiBody`/`@ApiResponse`/`@ApiParam`, and mounts Swagger UI via a new `openapi:` consumer config block.

## Four locked decisions

1. **Library: `@anatine/zod-openapi`** (de facto standard, maintained).
2. **Swagger UI default path: `/docs`** — configurable via `openapi.path` consumer config.
3. **Default security scheme: `BearerAuth`** — every consumer has a JWT auth path (Clerk, tenant tokens, etc.).
4. **OpenAPI version: 3.0.x** — Swagger UI tooling compatibility. Revisit when we adopt a UI that handles 3.1 cleanly.

---

## The 4-PR stack

Sequential. Each builds on the previous.

| # | Branch | Issue | Scope | Gate |
|---|---|---|---|---|
| 1 | `openapi-1/registry` | OPENAPI-1 | `runtime/shared/openapi/registry.ts` — vendored `OpenApiRegistry` helper; `@anatine/zod-openapi` as optional peer dep (lazy-import pattern from `analytics/cube-backend.ts`). `OPENAPI_REGISTRY` DI token. Unit tests for round-trip (Zod schema → OpenAPI JSON schema). | `just test-unit` green. **CHECKPOINT** after merge. |
| 2 | `openapi-2/dto-registration` | OPENAPI-2 | Hygen DTO template updates — generated DTOs register their Zod schemas with the registry at module init via `@Module({ providers: [...] })`. Both `templates/entity/new/backend/` and `templates/entity/new/clean-lite-ps/` pipelines. Baseline snapshots refreshed. | `just test-all` green (unit + baseline + smoke). |
| 3 | `openapi-3/controller-decorators` | OPENAPI-3 | Controller template updates — emit `@ApiOperation` (summary), `@ApiBody` (from request DTO), `@ApiResponse` (from response DTO + status codes), `@ApiParam` (for path params) decorators on every generated controller method. Both pipelines. Smoke test verifies `/docs-json` has populated `components.schemas` for all paths. **GATE** before opening — touches every generated controller; baseline regen review. | `just test-all` green. |
| 4 | `openapi-4/swagger-bootstrap` | OPENAPI-4 | `main.ts` bootstrap template — `SwaggerModule.setup(path, app, document, options)`; new `openapi:` consumer config block `{ enabled, path, title, version, description, auth }` with Hygen scaffold template. CONSUMER-SETUP §OpenAPI section. README one-liner. | `just test-all` green. Epic closes. |

**Gates (coordinator stops, reports, waits):**
1. CHECKPOINT after OPENAPI-1 — registry shape + peer-dep wiring sanity check.
2. GATE before OPENAPI-3 opens — decorator codegen touches every controller; baseline regen review.
3. Any CI failure not diagnosed in 2 attempts.
4. Any latent bug discovered in another subsystem → file separately.

---

## Files touched (~15 total)

### NEW

```
runtime/shared/openapi/registry.ts                  # OpenApiRegistry + DI token
runtime/shared/openapi/index.ts                     # barrel
src/__tests__/runtime/shared/openapi-registry.spec.ts
templates/subsystem/openapi-config/prompt.js        # Hygen scaffold for openapi: block
templates/subsystem/openapi-config/codegen-config-openapi-block.ejs.t
docs/specs/OPENAPI-1.md .. OPENAPI-4.md             # per-PR specs (this repo)
```

### MODIFY — templates (~6)

```
templates/entity/new/backend/dto.ejs.t              # register Zod schema on module init
templates/entity/new/backend/controller.ejs.t      # @Api* decorators
templates/entity/new/backend/module.ejs.t          # OpenApi registry provider
templates/entity/new/clean-lite-ps/dto.ejs.t       # same shape, lighter pipeline
templates/entity/new/clean-lite-ps/controller.ejs.t
templates/entity/new/clean-lite-ps/module.ejs.t
templates/project/main.ts.ejs.t                     # SwaggerModule.setup in bootstrap
```

### MODIFY — CLI (~2)

```
src/cli/commands/subsystem.ts                       # add 'openapi-config' dispatch
src/cli/shared/subsystem-detect.ts                  # add 'openapi-config' to union
```

### MODIFY — docs (~3)

```
docs/CONSUMER-SETUP.md                              # new §OpenAPI section
README.md                                           # one-liner mention
.claude/skills/openapi/SKILL.md                     # NEW — load-on-touch skill
```

---

## Risks

1. **Every generated controller gets touched in OPENAPI-3.** Baseline snapshots regenerate; review the diff carefully — any unintended whitespace/import churn will bloat the PR. Use `git diff --stat` as a tripwire.
2. **`@anatine/zod-openapi` peer-dep pattern.** Follow the `CubeAnalyticsBackend` lazy-import precedent exactly — if the dep isn't installed, the registry throws on first use, not at boot. Consumer apps that don't care about OpenAPI shouldn't fail to boot.
3. **Swagger UI + BearerAuth interaction.** `@ApiBearerAuth()` on controllers requires the security scheme registered in the Swagger document. Get this wrong and the "Authorize" button in UI does nothing. Integration-test `/docs` with a mock token.
4. **3.0.x choice locks out some Zod refinements.** `z.discriminatedUnion` and `.refine()` map imperfectly to 3.0 JSON Schema. Document the known gaps in CONSUMER-SETUP; flag the 3.1 migration path as a future.
5. **Nest's built-in `@nestjs/swagger` vs. our registry.** The registry produces OpenAPI JSON; `SwaggerModule` consumes it. Use `SwaggerModule.createDocument` with a pre-built document from our registry — don't let Nest's decorator scanning fight our Zod-driven schemas. One source of truth.

---

## Orchestration

**One coordinator, sequential `/develop` loops, single branch per issue.**

**CRITICAL — coordinator delegates from turn one:**
- Coordinator lacks Edit/Write tools; MUST spawn `implementer` teammates for code and `validator` teammates for tests.
- No inline code writing. No `python3 <<PY` heredocs. No Bash one-liners to modify files.
- For each PR: spawn implementer with spec path + acceptance criteria → wait for report → spawn validator for `just test-all` + self-review → review diff → open PR → merge.

Gates report to lead via `SendMessage` to `team-lead`.

---

## Dependency / sequencing

- **Standalone, no external dependencies.** Main at `070d602` (v0.3.0 release).
- **Unblocks ADR-026 Phase 1** — observability-api will use this OpenAPI surface for its `/ops/*` endpoints.
- **No coupling to bridge, jobs, events, sync** — all pre-existing and stable.
