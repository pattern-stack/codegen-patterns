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

- [ ] Both pipelines emit decorated controllers.
- [ ] `just test-all` green.
- [ ] `/docs-json` on smoke-generated project is fully populated (no empty `schema: {}` anywhere under `paths`).
- [ ] Gate passed before PR open.
