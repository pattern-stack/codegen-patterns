# OPENAPI-3 — Controller decorators

**Epic:** #TBD (OpenAPI Phase 1)
**Depends on:** OPENAPI-1, OPENAPI-2
**Blocks:** OPENAPI-4

## Scope

Update generated controller templates to emit NestJS OpenAPI decorators on every method. Both pipelines. This is the biggest-surface PR in the epic — every generated controller gets touched, baseline snapshots regenerate fully.

**GATE before opening** — baseline regen review (file count + whitespace/import churn inspection).

## Decorators to emit

For each controller method:
- `@ApiOperation({ summary: '...', operationId: '...' })` — operationId is stable (camelCase): `createAccount`, `listAccounts`, `findAccountById`, `updateAccount`, `deleteAccount`, plus declarative-query methods (`findAccountsByUserId`, etc.).
- `@ApiBody({ type: <RequestDto> })` — only on `POST` / `PATCH` / `PUT`.
- `@ApiResponse({ status: <N>, type: <ResponseDto> })` — one per status code. Generated from controller return type.
- `@ApiParam({ name: 'id', type: 'string', format: 'uuid' })` — for path params.
- `@ApiBearerAuth()` — at the controller class level (default security scheme; finalized in OPENAPI-4 wiring).

Standard status codes per verb (locked):
- `GET` (list): `200 Ok`, `401 Unauthorized`.
- `GET /:id`: `200`, `401`, `404 NotFound`.
- `POST`: `201 Created`, `400 BadRequest`, `401`.
- `PATCH /:id`: `200`, `400`, `401`, `404`.
- `DELETE /:id`: `204 NoContent`, `401`, `404`.

Error shape: reuse the existing `ErrorResponseDto` if present; otherwise generate a minimal `ErrorResponseDto` in OPENAPI-1/2 and register it globally.

## Files touched

### MODIFY — templates
- `templates/entity/new/backend/controller.ejs.t` — full CRUD + declarative queries.
- `templates/entity/new/clean-lite-ps/controller.ejs.t` — same.

### MODIFY — baseline snapshots
- `test/baseline/**/*.controller.ts` — all regenerated.

## Tests

1. **Baseline regen** — `just test-baseline` green.
2. **Smoke** — generated app's `/docs-json` has:
   - Every controller method listed under `paths.*`.
   - Every method has `operationId`, `summary`, `tags`.
   - Every method has at least one `responses.*` entry with `$ref` to a registered component.
   - `POST`/`PATCH` methods have `requestBody.content.application/json.schema.$ref`.
3. **Decorator ordering** — `@ApiOperation` before `@ApiResponse` before HTTP verb decorator (`@Get`/`@Post`/etc.). Lint-checked.
4. **Import hygiene** — no duplicate/unused `@nestjs/swagger` imports.

## Gate

**GATE before opening PR** — baseline diff review:
- Diff line count within expected range (~30–60 LOC per controller × N entities in baseline fixtures).
- No unintended whitespace/import churn beyond decorator emission.
- Spot-check two controllers (simple entity + complex entity with declarative queries).

Report to lead with diff stats + spot-check output before opening.

## Acceptance

- [x] Both pipelines emit decorated controllers.
- [x] `just test-all` green.
- [ ] `/docs-json` on smoke-generated project is fully populated (no empty `schema: {}` anywhere under `paths`). **Deferred to OPENAPI-4** — smoke test does `tsc --noEmit` only and does not boot Nest; the same gap was accepted in OPENAPI-2. OPENAPI-4 wires AppModule + `SwaggerModule.setup` and should add a boot-and-curl-`/docs-json` step to smoke.
- [x] Gate passed before PR open.

## Implementation notes (post-merge)

Decisions locked during implementation that deviate from the pre-implementation sketch:

1. **`$ref` everywhere, not `type:` class refs.** Generated DTOs are Zod-derived `type X = z.infer<...>` aliases — TypeScript types, not runtime classes. `@ApiBody({ type: CreateContactDto })` would be a "used as a value, only refers to a type" compile error. The decorators emit `@ApiBody({ schema: { $ref: '#/components/schemas/CreateContactDto' } })` and `@ApiResponse({ ..., schema: { $ref: ... } })`. This is architecturally consistent with OPENAPI-2 — which already registered schemas **by string name** in the `OpenApiRegistry` — and sidesteps the need to generate runtime class shells purely as reflection targets. Swagger UI resolves the `$ref` against the registered schemas emitted on `/docs-json`. Net: Zod-first stays intact, no class duplication.

2. **Backend pipeline gets a `<Entity>ResponseDto` — added to the existing `<entity>.dto.ts` file, not a new template file.** The backend DTO template previously emitted only create + update schemas. OPENAPI-3 extends the same file with `<camelName>ResponseSchema` (Zod) + `<Entity>ResponseDto` (type alias). The response shape mirrors the entity's full select shape: `id` + all declared fields + `createdAt/updatedAt` (if `hasTimestamps`) + `deletedAt` (if `hasSoftDelete`) + `validFrom/validTo/isActive` (if `hasTemporalValidity`). No response-side `.optional()` — columns are present on every returned row.

3. **CLP untouched on DTO side.** CLP already emits `<Entity>OutputDto` with the right shape and register it as `OutputDto` in the registry (OPENAPI-2 note). CLP controller decorators reference `#/components/schemas/<Entity>OutputDto` accordingly. No `ResponseDto` rename — would have broken OPENAPI-2 consistency for zero gain.

4. **Shared `ErrorResponseDto` added to `runtime/shared/openapi/error-response.dto.ts`.** Schema shape matches NestJS's `HttpException` JSON body: `{ statusCode: number.int(), message: string | string[], error?: string }`. The registry **auto-registers** it on construction (and re-seeds it on `reset()`), so every consumer project exposes `components.schemas.ErrorResponseDto` on `/docs-json` without per-entity duplication. Generated 4xx `@ApiResponse` decorators `$ref` this single schema. Vendored via `init-scaffold.ts::VENDORED_RUNTIME_FILES`.

5. **`@nestjs/swagger` is an optional peer dep.** Added to `peerDependencies` (`^7.0.0 || ^8.0.0`) and `peerDependenciesMeta` (optional) in `package.json`. Generated controllers import decorator functions at the top — unlike the `@anatine/zod-openapi` peer which is lazy-imported, these are unconditional static imports. Consumer apps that don't install `@nestjs/swagger` will get a module-not-found error at runtime when any generated controller loads. That matches the OPENAPI-4 bootstrap, which also requires the peer; acceptable because the epic is scoped to projects opting into OpenAPI.

6. **Class-level `@ApiBearerAuth()` is unconditional.** Finalized "universal default" per gate decision — any controller that needs a different security scheme can override at the method level in a manual overlay. Not configurable via YAML in Phase 1.

7. **`operationId` is bare camelCase, no module prefix.** Matches the gate decision; bounded-context operationIds (e.g., `sales.createOpportunity`) are deferred to a future ADR. Naming pattern: `list<Plural>`, `find<Entity>ById`, `create<Entity>`, `update<Entity>`, `delete<Entity>`.

8. **PUT, not PATCH, on the backend pipeline.** The backend controller template uses `@Put(':id')` for updates (pre-existing convention — full replacement semantics via Zod's `.optional()` on every field). CLP uses `@Patch`. Decorators are attached to whichever verb each template actually emits; the spec's reference to PATCH was conformed to the generated code rather than rewriting the routing layer.

9. **Declarative-query methods not added to the backend controller.** The backend `controller.ejs.t` doesn't emit declarative-query handlers today — those live on the query classes but aren't exposed over REST in the backend pipeline. Only the standard five CRUD methods get decorators. (CLP's controller also doesn't emit them — same story.) If a future spec wires declarative-query REST endpoints, decorator emission will land in the same template.

10. **Smoke test gap — not closed here.** The smoke test still runs `tsc --noEmit` only. Booting the generated app and curling `/docs-json` requires OPENAPI-4 (AppModule registers `OPENAPI_REGISTRY` as a provider; `SwaggerModule.setup` awaits `build()` and mounts the UI). Adding the boot step to smoke is the natural place for the `schema.$ref` assertions in §Tests item 2. Captured as an OPENAPI-4 task.

11. **Unit tests updated.** `src/__tests__/runtime/shared/openapi-registry.spec.ts` now asserts the auto-registered `ErrorResponseDto` is always present in `components.schemas` (invariant replaces the previous "empty components.schemas" assertion). `src/__tests__/schema/field-type-to-zod.test.ts` picks up the new template locals (`camelName`, `hasTimestamps`, `hasSoftDelete`, `hasTemporalValidity`) required to render the response schema block.

12. **Baseline diff is within the predicted envelope.** +648/-13 across 32 files: 7 controllers (~42 LOC each, one simpler at +32), 7 DTOs (+12–20 LOC each), 7 modules (+3 LOC each), plus the template + runtime additions. No whitespace/import noise beyond decorator emission and the new response schema.
