# A10: BaseService\<TRepo, TEntity\> + Read Use Cases

**Status:** Draft
**Last Updated:** 2026-04-12
**Depends on:** A9 (BaseRepository)
**References:** ADR-003 (updated), ADR-005, contact module sketch

## Overview

Hand-written abstract class at `shared/base-classes/base-service.ts` providing 8 CRUD methods delegating to repository. Plus `BaseFindByIdUseCase` and `BaseListUseCase` abstract classes that auto-generated read use cases extend. Controllers always import use cases, never services (ADR-003 no-exceptions rule).

**Note:** The contact module sketch shows controller importing ContactService directly for reads (CQRS-lite). ADR-003 explicitly rejected this. This spec follows ADR-003.

## BaseService Interface

```typescript
@Injectable()
abstract class BaseService<TRepo extends IBaseRepository<TEntity>, TEntity> {
  constructor(protected readonly repository: TRepo) {}

  findById(id: string): Promise<TEntity | null> { return this.repository.findById(id); }
  findByIds(ids: string[]): Promise<TEntity[]> { return this.repository.findByIds(ids); }
  list(filters?: Record<string, unknown>): Promise<TEntity[]> { return this.repository.list(filters); }
  count(filters?: Record<string, unknown>): Promise<number> { return this.repository.count(filters); }
  exists(id: string): Promise<boolean> { return this.repository.exists(id); }
  create(input: Partial<TEntity>): Promise<TEntity> { return this.repository.create(input); }
  update(id: string, input: Partial<TEntity>): Promise<TEntity> { return this.repository.update(id, input); }
  delete(id: string): Promise<void> { return this.repository.delete(id); }
}
```

All methods are pure pass-throughs. No side effects per ADR-003.

## Read Use Case Pattern

**Design choice: single generated file per entity, two named exports.**

Rationale: fewer files than one-per-use-case, but controller still imports specific named classes (ESLint-friendly).

### Base classes

```typescript
// shared/base-classes/base-read-use-cases.ts

@Injectable()
abstract class BaseFindByIdUseCase<TService extends { findById(id: string): Promise<TEntity | null> }, TEntity> {
  constructor(protected readonly service: TService) {}
  execute(id: string): Promise<TEntity | null> { return this.service.findById(id); }
}

@Injectable()
abstract class BaseListUseCase<TService extends { list(): Promise<TEntity[]> }, TEntity> {
  constructor(protected readonly service: TService) {}
  execute(): Promise<TEntity[]> { return this.service.list(); }
}
```

### Generated output per entity (by codegen template)

```typescript
// modules/contacts/use-cases/contact-read.use-cases.ts
// AUTO-GENERATED — do not edit

@Injectable()
export class ContactFindByIdUseCase extends BaseFindByIdUseCase<ContactService, Contact> {
  constructor(service: ContactService) { super(service); }
}

@Injectable()
export class ContactListUseCase extends BaseListUseCase<ContactService, Contact> {
  constructor(service: ContactService) { super(service); }
}
```

### Controller usage (corrected from sketch)

```typescript
@Controller('contacts')
export class ContactController {
  constructor(
    private readonly findById: ContactFindByIdUseCase,  // NOT ContactService
    private readonly list: ContactListUseCase,
    private readonly newContact: NewContactUseCase,      // hand-written
  ) {}

  @Get(':id') getById(@Param('id') id: string) { return this.findById.execute(id); }
  @Get() listAll() { return this.list.execute(); }
  @Post() create(@Body() dto) { return this.newContact.execute(dto); }
}
```

### Module registration

Both use case classes registered as providers. Service still exported for cross-domain reads.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `shared/base-classes/base-service.ts` | create | BaseService abstract class |
| `shared/base-classes/base-read-use-cases.ts` | create | BaseFindByIdUseCase + BaseListUseCase |
| `shared/base-classes/index.ts` | update | Add exports |
| `shared/base-classes/base-service.spec.ts` | create | Delegation tests (mock repo) |
| `shared/base-classes/base-read-use-cases.spec.ts` | create | Delegation tests (mock service) |

## Acceptance Criteria

- [ ] `ContactService extends BaseService<ContactRepository, Contact>` compiles
- [ ] All 8 CRUD methods delegate to repository
- [ ] `ContactFindByIdUseCase.execute(id)` calls `service.findById(id)`
- [ ] `ContactListUseCase.execute()` calls `service.list()`
- [ ] Controller imports only `*.use-case` classes — no direct service import
- [ ] ESLint rule "controllers may only import *.use-case.ts" is satisfiable with this shape
