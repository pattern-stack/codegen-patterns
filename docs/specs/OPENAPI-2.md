# OPENAPI-2 — DTO schema registration at module init

**Epic:** #TBD (OpenAPI Phase 1)
**Depends on:** OPENAPI-1 (registry)
**Blocks:** OPENAPI-3, OPENAPI-4

## Scope

Update Hygen DTO templates so every generated DTO **registers its Zod schema** with `OpenApiRegistry` at module init. Both pipelines — `templates/entity/new/backend/` (full Clean Architecture) and `templates/entity/new/clean-lite-ps/` (lite variant). Baseline snapshots refreshed.

## Files touched

### MODIFY — templates
- `templates/entity/new/backend/dto.ejs.t` — emit `registerOpenApiSchema(<EntityName>Dto, <name>Schema)` in module `onModuleInit`.
- `templates/entity/new/backend/module.ejs.t` — inject `OpenApiRegistry` + call registration for each DTO in the module.
- `templates/entity/new/clean-lite-ps/dto.ejs.t` — same shape.
- `templates/entity/new/clean-lite-ps/module.ejs.t` — same shape.

### MODIFY — baseline snapshots
- `test/baseline/**/*.dto.ts` — regenerated.
- `test/baseline/**/*.module.ts` — regenerated.

## Template shape

Generated DTO module gets an injected registration hook:

```ts
// <entity>.module.ts (generated)
@Module({ /* ... existing providers ... */ })
export class <Entity>Module implements OnModuleInit {
  constructor(
    @Inject(OPENAPI_REGISTRY) private readonly openApi: OpenApiRegistry,
  ) {}

  onModuleInit() {
    this.openApi.registerSchema('Create<Entity>Dto', createDtoZodSchema);
    this.openApi.registerSchema('Update<Entity>Dto', updateDtoZodSchema);
    this.openApi.registerSchema('<Entity>ResponseDto', responseDtoZodSchema);
  }
}
```

Naming convention: `<Operation><Entity>Dto` (e.g., `CreateAccountDto`, `UpdateAccountDto`, `AccountResponseDto`). This matches the NestJS convention and what Swagger UI displays.

## Tests (integration + baseline)

1. **Baseline regen** — `just test-baseline` passes with regenerated DTO + module files.
2. **Smoke** — `just test-smoke` generates a fresh project that boots and exposes registered schemas on `/docs-json` (assert `components.schemas.CreateAccountDto` is present).
3. **Schema round-trip** — parse the emitted `/docs-json` JSON; every generated DTO has a `components.schemas.*` entry.
4. **Module DI** — `OpenApiRegistry` is `@Inject`ed via `OPENAPI_REGISTRY` token, not constructor type (registry is provided by `AppModule`, not the entity module).

## Acceptance

- [ ] Both pipelines emit DTOs that register with the registry at `onModuleInit`.
- [ ] `just test-all` green (unit + baseline + smoke).
- [ ] Smoke test's generated project exposes populated `components.schemas` on `/docs-json`.
- [ ] No duplicate schema registrations across entities (if two entities both register `CreateFooDto`, registry warns/errors per OPENAPI-1 decision).
- [ ] Module template imports are clean — no unused imports.
