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

## Implementation notes (post-merge)

1. **DTO templates untouched** — existing templates already export `create<Entity>Schema` + `update<Entity>Schema` (backend) / `createSchema`, `updateSchema`, `outputSchema` (clean-lite-ps). No DTO-side work was needed.
2. **Vendored runtime path.** `runtime/shared/openapi/*` was added to `VENDORED_RUNTIME_FILES` in `src/cli/shared/init-scaffold.ts` so `codegen project init` copies the registry into consumer projects at `src/shared/openapi/*`. Generated modules `import from '@shared/openapi'` and that alias resolves into the consumer's own src tree — required to avoid the dual-drizzle type-identity clash documented inline in `init-scaffold.ts`.
3. **Clean-lite-ps response DTO naming.** Spec sketch used `<Entity>ResponseDto`. CLP's existing convention is `<Entity>OutputDto` (wired everywhere else in CLP). Registered as `OutputDto` to avoid a mismatch between the registry key and the rest of the CLP pipeline. OPENAPI-3 decorators will reference the same key.
4. **Backend pipeline registers Create + Update only.** It has no response DTO today; only two schemas are registered per entity. CLP registers three (Create + Update + Output).
5. **Registry injected via `@Inject(OPENAPI_REGISTRY)`; class imported as type only.** Matches the "registry provided by AppModule, not the entity module" intent — no runtime class reference in the generated module file.
6. **`generate.dtos: false` gate.** Backend DTO emission already respects this flag; the registration imports mirror the same gate so no unused imports appear when DTOs are disabled. CLP has no equivalent flag (CLP always emits DTOs when enabled).
7. **Known gap between OPENAPI-2 and OPENAPI-4:** generated modules inject `OPENAPI_REGISTRY` but no provider supplies it yet. `AppModule` wiring lands in OPENAPI-4. Smoke test uses `tsc --noEmit` only, so this DI gap is invisible to CI — a Nest boot between OPENAPI-2 and OPENAPI-4 would throw at resolution. Acceptable per the epic plan; OPENAPI-4 resolves.
8. **`entityNamePascal` not yet in CLP template locals.** `prompt-extension.js` has it in closure scope only; the OutputDto schema name was derived from `classNames.outputDto` instead. If OPENAPI-3/4 need `entityNamePascal` directly in CLP templates, add it to locals in `prompt-extension.js`.
