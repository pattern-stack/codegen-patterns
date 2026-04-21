# Framework: NestJS

Conventions and patterns for NestJS applications. Extends the TypeScript language primitive.

## File Patterns

| Kind | Pattern |
|------|---------|
| Module | `**/*.module.ts` |
| Controller | `**/*.controller.ts` |
| Service | `**/*.service.ts` |
| Repository | `**/*.repository.ts` |
| DTO | `**/dto/**/*.ts` or `**/*.dto.ts` |
| Guard / Pipe / Interceptor | `**/*.guard.ts`, `**/*.pipe.ts`, `**/*.interceptor.ts` |
| E2E tests | `test/**/*.e2e-spec.ts` |

## Module Structure

A feature module typically contains:

```
<feature>/
├── <feature>.module.ts          # @Module registration
├── <feature>.controller.ts      # HTTP routes, delegates to service
├── <feature>.service.ts         # Use-case orchestration
├── <feature>.repository.ts      # Data access (if applicable)
├── dto/
│   ├── create-<feature>.dto.ts
│   └── update-<feature>.dto.ts
└── entities/
    └── <feature>.entity.ts
```

## Dependency Injection

- Prefer **constructor injection** with `private readonly`
- Use **injection tokens** (`const X_TOKEN = Symbol('X')`) for interface-based DI, not class-based
- Register providers at the module level; avoid `@Global()` except for true cross-cutting concerns (logger, config)

```ts
// Controller
constructor(
  @Inject(USER_SERVICE) private readonly users: IUserService,
) {}
```

## Request Lifecycle

```
Request
  → Guard(s)      # auth, role checks
  → Interceptor   # transform / log
  → Pipe(s)       # validate / transform input
  → Controller    # route handler
  → Service       # business logic
  → Repository    # data access
```

## Validation

- Use **`ZodValidationPipe`** (or `class-validator` + `ValidationPipe`) at the controller boundary
- DTOs are the contract — never accept raw `any` in controller signatures
- Apply `ParseUUIDPipe` (or equivalent) on ID route params

## Error Handling

- Throw Nest's built-in exceptions from services (`NotFoundException`, `BadRequestException`, …)
- Use exception filters for cross-cutting error translation (e.g., domain exception → HTTP)
- Do not leak repository errors to the controller — map in the service layer

## Testing

- Unit: test services / use cases with mocked repositories (no Nest testing module needed)
- Module: use `Test.createTestingModule(...)` when DI wiring is part of what's being tested
- E2E: use `supertest` against a compiled app for route-level assertions

## Framework-Specific Gates

Add to `sdlc.yml` `commands:` as needed:

```yaml
commands:
  test_e2e: bun run test:e2e       # NestJS E2E suite
  check_imports: bun run madge     # optional circular dependency check
```

## Strategy Considerations

- Identify whether the project uses **global pipes / guards / interceptors** (registered in `main.ts`) vs per-module — affects where to wire new behavior
- Check for a **shared module** (logger, config, database) — reuse rather than re-register
- Check ORM choice (Drizzle, TypeORM, Prisma) — DTOs, repositories, and migration patterns follow from there
- Identify deployment target — serverless deploys have different module lifecycle considerations than long-running processes
