# Spec A6 — Clean-Lite-PS Template Set

**Status:** Shipped. Post-implementation note added 2026-04-21 below.
**Issue:** A6
**Related ADRs:** ADR-002, ADR-003, ~~ADR-005~~ → superseded by [ADR-031](../../docs/adrs/ADR-031-app-defined-patterns.md)
**Reference output:** `docs/architecture/sketches/contact-module-sketch.md`

> **Post-implementation revision (2026-04-21, PATTERN-5):** this spec was
> written when the YAML surface was `family: synced | activity | ...` and
> the base-class choice was driven by a hard-coded `FAMILY_MAP` in
> `templates/entity/new/clean-lite-ps/prompt-extension.js`. That surface has
> been replaced by the pattern registry per ADR-031. Read occurrences of
> "family" below as "library pattern name (lowercase)" and occurrences of
> `entity.family` as `entity.pattern` (single) or `entity.patterns[0]`
> (multi). The five library patterns (Base / Synced / Activity / Knowledge
> / Metadata) are pre-registered; consumer-defined patterns are discovered
> via `codegen.config.yaml patterns:` globs. See the "App-defined patterns"
> section of `docs/CONSUMER-SETUP.md` for authoring details.

---

## Overview

Introduce a new Hygen EJS template set that generates domain-first NestJS modules following the Clean-Lite-PS (Pattern Stack) architecture. The template set lives at `templates/entity/new/clean-lite-ps/` and produces 11 files per entity, all colocated under a single `modules/<plural>/` directory.

This replaces the dispersed output of the current `backend/` template tree (separate `domain/`, `application/`, `infrastructure/`, `presentation/` outputs) with a single-directory module that includes every layer.

---

## Files to Create

| File | Action | Description |
|------|--------|-------------|
| `templates/entity/new/clean-lite-ps/entity.ejs.t` | create | Drizzle table + relations + inferred types |
| `templates/entity/new/clean-lite-ps/repository.ejs.t` | create | Family base class extension, entity-specific skeleton |
| `templates/entity/new/clean-lite-ps/service.ejs.t` | create | Family service extension with WithAnalytics mixin |
| `templates/entity/new/clean-lite-ps/use-cases/find-by-id.ejs.t` | create | FindById use case delegating to service |
| `templates/entity/new/clean-lite-ps/use-cases/list.ejs.t` | create | List use case delegating to service |
| `templates/entity/new/clean-lite-ps/controller.ejs.t` | create | Thin REST adapter, all routes through use cases |
| `templates/entity/new/clean-lite-ps/module.ejs.t` | create | NestJS module wiring imports/providers/exports |
| `templates/entity/new/clean-lite-ps/dto/create.ejs.t` | create | Zod create schema |
| `templates/entity/new/clean-lite-ps/dto/update.ejs.t` | create | Zod update schema (partial of create) |
| `templates/entity/new/clean-lite-ps/dto/output.ejs.t` | create | Zod output schema including all fields |
| `templates/entity/new/clean-lite-ps/prompt-extension.js` | create | Template locals extension for clean-lite-ps variables |

No existing files are modified by this spec. The existing `backend/` template tree is untouched.

---

## Interface Definitions

### Template Locals (available in all templates)

All variables from the existing `prompt.js` are available. The clean-lite-ps templates additionally require:

```typescript
interface CleanLitePsLocals {
  // Entity identity
  entityName: string;           // "contact"
  entityNamePascal: string;     // "Contact"
  entityNamePlural: string;     // "contacts"
  entityNamePluralPascal: string; // "Contacts"

  // Family
  family: 'crm-synced' | 'activity' | 'knowledge' | 'metadata' | 'base';

  // Base class names (derived from family)
  repositoryBaseClass: string;  // "CrmEntityRepository"
  serviceBaseClass: string;     // "CrmEntityService"

  // Import paths for base classes
  repositoryBaseImport: string; // "@shared/base-classes/crm-entity-repository"
  serviceBaseImport: string;    // "@shared/base-classes/crm-entity-service"

  // Output paths (all relative to project root)
  outputPaths: {
    entity: string;             // "modules/contacts/contact.entity.ts"
    repository: string;         // "modules/contacts/contact.repository.ts"
    service: string;            // "modules/contacts/contact.service.ts"
    controller: string;         // "modules/contacts/contact.controller.ts"
    module: string;             // "modules/contacts/contacts.module.ts"
    findByIdUseCase: string;    // "modules/contacts/use-cases/find-contact-by-id.use-case.ts"
    listUseCase: string;        // "modules/contacts/use-cases/list-contacts.use-case.ts"
    createDto: string;          // "modules/contacts/dto/create-contact.dto.ts"
    updateDto: string;          // "modules/contacts/dto/update-contact.dto.ts"
    outputDto: string;          // "modules/contacts/dto/contact-output.dto.ts"
  };

  // Class names
  classNames: {
    entity: string;             // "Contact"
    entityTable: string;        // "contacts" (Drizzle table variable)
    repository: string;         // "ContactRepository"
    service: string;            // "ContactService"
    controller: string;         // "ContactController"
    module: string;             // "ContactsModule"
    findByIdUseCase: string;    // "FindContactByIdUseCase"
    listUseCase: string;        // "ListContactsUseCase"
    createDto: string;          // "CreateContactDto"
    updateDto: string;          // "UpdateContactDto"
    outputDto: string;          // "ContactOutputDto"
    createSchema: string;       // "CreateContactSchema"
    updateSchema: string;       // "UpdateContactSchema"
    outputSchema: string;       // "ContactOutputSchema"
  };

  // Fields (processed for template use)
  processedFields: ProcessedField[];

  // Relationships (for FK columns and relations block)
  belongsTo: BelongsToRelation[];  // generates FK columns + relations()

  // Behaviors (from existing behavior registry)
  behaviorFields: BehaviorField[];
  hasTimestamps: boolean;
  hasSoftDelete: boolean;
}

interface ProcessedField {
  name: string;           // "first_name" (snake_case)
  camelName: string;      // "firstName"
  drizzleType: string;    // "text"
  zodType: string;        // "z.string().min(1)"
  tsType: string;         // "string"
  nullable: boolean;
  required: boolean;      // !nullable && no default
  hasDefault: boolean;
  isPrimaryKey: boolean;
  drizzleChain: string;   // full drizzle column definition e.g. text('first_name').notNull()
}

interface BelongsToRelation {
  field: string;          // "account_id"
  camelField: string;     // "accountId"
  relatedEntity: string;  // "account"
  relatedEntityPascal: string; // "Account"
  relatedTable: string;   // "accounts"
  relatedPlural: string;  // "accounts"
  nullable: boolean;
  importPath: string;     // "../accounts/account.entity"
}
```

### Family → Base Class Mapping

| Family YAML value | Repository base | Service base | Import path prefix |
|-------------------|----------------|--------------|-------------------|
| `crm-synced` | `CrmEntityRepository` | `CrmEntityService` | `@shared/base-classes/crm-entity-*` |
| `activity` | `ActivityEntityRepository` | `ActivityEntityService` | `@shared/base-classes/activity-entity-*` |
| `knowledge` | `KnowledgeEntityRepository` | `KnowledgeEntityService` | `@shared/base-classes/knowledge-entity-*` |
| `metadata` | `MetadataEntityRepository` | `MetadataEntityService` | `@shared/base-classes/metadata-entity-*` |
| `base` (default) | `BaseRepository` | `BaseService` | `@shared/base-classes/base-*` |

When no `family` key is present in the entity YAML, default to `base`.

---

## Template Specifications

### 1. `entity.ejs.t`

**Output path:** `modules/<plural>/<entity>.entity.ts`

**Hygen header:**
```
---
to: modules/<%= entityNamePlural %>/<%= entityName %>.entity.ts
force: true
---
```

**Content structure:**

```typescript
import { pgTable, uuid, /* field-derived imports */ } from 'drizzle-orm/pg-core';
import { relations, type InferSelectModel } from 'drizzle-orm';
// One import per belongs_to relation:
// import { <relatedTable> } from '../<relatedPlural>/<relatedEntity>.entity';

export const <%= entityNamePlural %> = pgTable(
  '<%= entityNamePlural %>',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // FK columns from belongs_to relationships:
    // <camelField>: uuid('<field>')[.notNull()][.references(() => <relatedTable>.id)],
    // Regular fields from processedFields:
    // <camelName>: <drizzleChain>,
    // Behavior fields appended last (created_at, updated_at, deleted_at, etc.)
  },
);

// Only emitted when belongs_to relations exist:
export const <%= entityNamePlural %>Relations = relations(<%= entityNamePlural %>, ({ one }) => ({
  // one per belongs_to:
  // <relatedEntity>: one(<relatedTable>, { fields: [<%= entityNamePlural %>.<camelField>], references: [<relatedTable>.id] }),
}));

export type <%= classNames.entity %> = InferSelectModel<typeof <%= entityNamePlural %>>;
export type <%= classNames.entity %>Insert = typeof <%= entityNamePlural %>.$inferInsert;
```

**Field → Drizzle type mapping** (same mapping used in existing `schema.ejs.t`):

| YAML type | Drizzle function | Chain modifiers |
|-----------|-----------------|-----------------|
| `string` | `text` | `.notNull()` if required |
| `uuid` | `uuid` | `.notNull()` if required, `.references()` if FK |
| `integer` | `integer` | `.notNull()` if required |
| `decimal` | `numeric` | `.notNull()` if required |
| `boolean` | `boolean` | `.notNull()` if required, `.default(val)` if has default |
| `date` | `date` | `.notNull()` if required |
| `datetime` | `timestamp` | `.notNull()` if required, `.defaultNow()` for timestamps |
| `json` | `jsonb` | `.notNull()` if required |

Drizzle imports are collected from all used types and listed at the top of the file.

---

### 2. `repository.ejs.t`

**Output path:** `modules/<plural>/<entity>.repository.ts`

**Content structure:**

```typescript
import { Injectable, Inject } from '@nestjs/common';
import { DRIZZLE } from '@shared/constants/tokens';
import type { DrizzleClient } from '@shared/types/drizzle';
import { <%= repositoryBaseClass %> } from '<%= repositoryBaseImport %>';
import { <%= entityNamePlural %>, type <%= classNames.entity %> } from './<%= entityName %>.entity';

@Injectable()
export class <%= classNames.repository %> extends <%= repositoryBaseClass %><<%= classNames.entity %>> {
  readonly table = <%= entityNamePlural %>;

  constructor(@Inject(DRIZZLE) db: DrizzleClient) {
    super(db);
  }

  // TODO: Add entity-specific query methods here.
  // Inherited from <%= repositoryBaseClass %>:
  //   findById, findByIds, list, count, exists, create, update, delete, upsertMany
  // [family-specific inherited methods listed as comments per family]
}
```

**Family-specific inherited method comments:**

- `crm-synced`: also lists `findByExternalId, findAllByUserId, findVisibleByUserId, syncUpsert`
- `activity`: also lists `findByDateRange, findByUserId, findByOpportunityId, findRecentByOpportunityId`
- `knowledge`: also lists `semanticSearch, findPendingByOpportunityId, updateStatus, updateStatusBatch`
- `metadata`: also lists `findByEntityIdAndType, listByEntityId, listHistoryByEntityId`

---

### 3. `service.ejs.t`

**Output path:** `modules/<plural>/<entity>.service.ts`

**Content structure:**

```typescript
import { Injectable } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/base-analytics-service';
import { <%= serviceBaseClass %> } from '<%= serviceBaseImport %>';
import { <%= classNames.repository %> } from './<%= entityName %>.repository';
import type { <%= classNames.entity %> } from './<%= entityName %>.entity';

@Injectable()
export class <%= classNames.service %> extends WithAnalytics(
  <%= serviceBaseClass %><<%= classNames.repository %>, <%= classNames.entity %>>,
) {
  constructor(protected readonly repository: <%= classNames.repository %>) {
    super();
  }

  // TODO: Add entity-specific domain methods here.
  // Services contain pure data operations only (ADR-003).
  // Do NOT emit events, enqueue jobs, or call external systems from service methods.
  //
  // Inherited from <%= serviceBaseClass %>:
  //   findById, findByIds, list, count, exists, create, update, delete
  // [family-specific inherited methods listed as comments]
}
```

No side effects are emitted in the skeleton. The comment block cites ADR-003 to guide hand-written additions.

---

### 4. `use-cases/find-by-id.ejs.t`

**Output path:** `modules/<plural>/use-cases/find-<entity>-by-id.use-case.ts`

**Content structure:**

```typescript
import { Injectable } from '@nestjs/common';
import { <%= classNames.service %> } from '../<%= entityName %>.service';
import type { <%= classNames.entity %> } from '../<%= entityName %>.entity';

@Injectable()
export class <%= classNames.findByIdUseCase %> {
  constructor(private readonly service: <%= classNames.service %>) {}

  async execute(id: string): Promise<<%= classNames.entity %> | null> {
    return this.service.findById(id);
  }
}
```

This is an auto-generated read use case. It exists to satisfy the no-exceptions rule from ADR-003: controllers always call use cases, including for reads.

---

### 5. `use-cases/list.ejs.t`

**Output path:** `modules/<plural>/use-cases/list-<plural>.use-case.ts`

**Content structure:**

```typescript
import { Injectable } from '@nestjs/common';
import { <%= classNames.service %> } from '../<%= entityName %>.service';
import type { <%= classNames.entity %> } from '../<%= entityName %>.entity';

@Injectable()
export class <%= classNames.listUseCase %> {
  constructor(private readonly service: <%= classNames.service %>) {}

  async execute(): Promise<<%= classNames.entity %>[]> {
    return this.service.list();
  }
}
```

---

### 6. `controller.ejs.t`

**Output path:** `modules/<plural>/<entity>.controller.ts`

**Content structure:**

```typescript
import { Controller, Get, Post, Put, Delete, Param, Body } from '@nestjs/common';
import { <%= classNames.findByIdUseCase %> } from './use-cases/find-<%= entityName %>-by-id.use-case';
import { <%= classNames.listUseCase %> } from './use-cases/list-<%= entityNamePlural %>.use-case';
import type { <%= classNames.entity %> } from './<%= entityName %>.entity';
// Write use cases must be hand-written. Import them here when ready.

@Controller('<%= entityNamePlural %>')
export class <%= classNames.controller %> {
  constructor(
    // All routes go through use cases (ADR-003 — no controller → service shortcuts)
    private readonly findById: <%= classNames.findByIdUseCase %>,
    private readonly list: <%= classNames.listUseCase %>,
    // TODO: inject hand-written write use cases here
  ) {}

  @Get()
  async getAll(): Promise<<%= classNames.entity %>[]> {
    return this.list.execute();
  }

  @Get(':id')
  async getById(@Param('id') id: string): Promise<<%= classNames.entity %> | null> {
    return this.findById.execute(id);
  }

  // TODO: Add write routes. Each must call a hand-written use case, not the service.
  // Example:
  // @Post()
  // async create(@Body() dto: Create<%= classNames.entity %>Dto): Promise<<%= classNames.entity %>> {
  //   return this.createUseCase.execute(dto);
  // }
}
```

**Constraint:** The controller MUST NOT import any `*.repository.ts` file. Controllers import only `*.use-case.ts` files. This is enforced by the comment structure and will be verified by ESLint rules (file-pattern import restriction on `modules/` code).

---

### 7. `module.ejs.t`

**Output path:** `modules/<plural>/<plural>.module.ts`

**Content structure:**

```typescript
import { Module } from '@nestjs/common';
import { DatabaseModule } from '@shared/database/database.module';
// Cross-domain module imports (one per belongs_to relationship):
// import { <%= RelatedPluralModule %> } from '../<relatedPlural>/<relatedPlural>.module';

import { <%= classNames.repository %> } from './<%= entityName %>.repository';
import { <%= classNames.service %> } from './<%= entityName %>.service';
import { <%= classNames.controller %> } from './<%= entityName %>.controller';
import { <%= classNames.findByIdUseCase %> } from './use-cases/find-<%= entityName %>-by-id.use-case';
import { <%= classNames.listUseCase %> } from './use-cases/list-<%= entityNamePlural %>.use-case';

@Module({
  imports: [
    DatabaseModule,
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
    // Cross-domain modules from relationships:
    // <%= RelatedPluralModule %>,
  ],
  controllers: [<%= classNames.controller %>],
  providers: [
    <%= classNames.repository %>,
    <%= classNames.service %>,
    <%= classNames.findByIdUseCase %>,
    <%= classNames.listUseCase %>,
    // TODO: Register hand-written use cases here
  ],
  exports: [<%= classNames.service %>],  // Only service is exported (ADR-002)
})
export class <%= classNames.module %> {}
```

Per ADR-002, only the service is exported. Repositories and use cases are internal implementation details.

---

### 8. `dto/create.ejs.t`

**Output path:** `modules/<plural>/dto/create-<entity>.dto.ts`

**Content structure:**

```typescript
import { z } from 'zod';

export const <%= classNames.createSchema %> = z.object({
  // Fields from processedFields (excluding id, and behavior-managed fields):
  // Required string field:   fieldName: z.string().min(1),
  // Optional string field:   fieldName: z.string().optional(),
  // Nullable string field:   fieldName: z.string().nullable(),
  // Required UUID FK field:  fieldName: z.string().uuid(),
  // Optional UUID FK field:  fieldName: z.string().uuid().optional(),
  // Boolean with default:    fieldName: z.boolean().default(false),
  // Integer:                 fieldName: z.number().int(),
  // Decimal:                 fieldName: z.number(),
  // Date:                    fieldName: z.coerce.date(),
  // DateTime:                fieldName: z.coerce.date(),
  // JSON:                    fieldName: z.record(z.unknown()).optional(),
  // Enum (has choices):      fieldName: z.enum(['val1', 'val2']),
});

export type <%= classNames.createDto %> = z.infer<typeof <%= classNames.createSchema %>>;
```

**Field inclusion rules for create DTO:**
- Exclude `id` (auto-generated)
- Exclude behavior-managed fields: `created_at`, `updated_at`, `deleted_at`, `created_by`, `updated_by`, `valid_from`, `valid_to`, `is_active`
- Include all FK fields from `belongs_to` relationships (as `z.string().uuid()`)
- Include all explicit entity fields

**Zod type derivation:**

| YAML type | Zod chain | Nullable modifier | Optional modifier |
|-----------|-----------|-------------------|-------------------|
| `string` | `z.string()` | `.nullable()` | `.optional()` |
| `uuid` | `z.string().uuid()` | `.nullable()` | `.optional()` |
| `integer` | `z.number().int()` | `.nullable()` | `.optional()` |
| `decimal` | `z.number()` | `.nullable()` | `.optional()` |
| `boolean` | `z.boolean()` | — | `.optional()` |
| `date` | `z.coerce.date()` | `.nullable()` | `.optional()` |
| `datetime` | `z.coerce.date()` | `.nullable()` | `.optional()` |
| `json` | `z.record(z.unknown())` | `.nullable()` | `.optional()` |

When a field has `choices`, use `z.enum([...])` regardless of base type.

---

### 9. `dto/update.ejs.t`

**Output path:** `modules/<plural>/dto/update-<entity>.dto.ts`

**Content structure:**

```typescript
import { z } from 'zod';
import { <%= classNames.createSchema %> } from './create-<%= entityName %>.dto';

export const <%= classNames.updateSchema %> = <%= classNames.createSchema %>.partial();

export type <%= classNames.updateDto %> = z.infer<typeof <%= classNames.updateSchema %>>;
```

This is a strict one-liner using Zod's `.partial()`. No field-by-field redeclaration.

---

### 10. `dto/output.ejs.t`

**Output path:** `modules/<plural>/dto/<entity>-output.dto.ts`

**Content structure:**

```typescript
import { z } from 'zod';

export const <%= classNames.outputSchema %> = z.object({
  id: z.string().uuid(),
  // All entity fields including nullable ones:
  // FK fields from belongs_to:  fieldName: z.string().uuid().nullable(),
  // All processedFields using same Zod mapping as create, but nullable allowed
  // Behavior timestamp fields:
  // createdAt: z.coerce.date(),
  // updatedAt: z.coerce.date(),
  // deletedAt: z.coerce.date().nullable(),  (if soft_delete)
});

export type <%= classNames.outputDto %> = z.infer<typeof <%= classNames.outputSchema %>>;
```

**Field inclusion rules for output DTO:**
- Include `id`
- Include all entity fields (nullable where applicable)
- Include all FK fields from `belongs_to`
- Include behavior-managed fields present on the entity (`created_at` → `createdAt`, `updated_at` → `updatedAt`, `deleted_at` → `deletedAt`)

---

## Implementation Steps

### Step 1 — Build the `prompt-extension.js` locals derivation

Create `templates/entity/new/clean-lite-ps/prompt-extension.js` that exports a function `buildCleanLitePsLocals(definition, baseLocals)`. This function:

1. Reads `entity.family` from the YAML definition (defaulting to `'base'` if absent)
2. Maps family to base class names using the family mapping table above
3. Derives all output paths using the pattern `modules/<plural>/<file>`
4. Derives all class names using `pascalCase` of entity name
5. Processes fields into `ProcessedField[]` shape
6. Processes `relationships.belongs_to` entries into `BelongsToRelation[]` shape
7. Returns a merged locals object

The existing `prompt.js` invokes this function when `generate.cleanLitePs: true` is set in `codegen.config.yaml` and merges the result into the Hygen locals before returning.

### Step 2 — Create the entity template

Implement `entity.ejs.t`. Verify:
- Drizzle imports are collected from field types and behavior types
- FK columns appear before entity fields
- `relations()` block is omitted when there are no `belongs_to` entries
- `$inferInsert` type is always emitted

### Step 3 — Create the repository template

Implement `repository.ejs.t`. Verify:
- Extends the correct family base class
- `readonly table` is assigned
- Constructor uses `@Inject(DRIZZLE)` token
- Inherited method comment block lists family-specific methods

### Step 4 — Create the service template

Implement `service.ejs.t`. Verify:
- Extends `WithAnalytics(FamilyEntityService<Repo, Entity>)` with correct generic parameters
- Constructor uses `protected readonly`
- ADR-003 comment is present

### Step 5 — Create the two read use case templates

Implement `use-cases/find-by-id.ejs.t` and `use-cases/list.ejs.t`. Both are thin pass-throughs.

### Step 6 — Create the controller template

Implement `controller.ejs.t`. Verify:
- No repository imports present
- Only use-case classes injected in constructor
- Write route stubs are comments, not live code

### Step 7 — Create the module template

Implement `module.ejs.t`. Verify:
- `exports` array contains only the service
- Cross-domain module import stubs appear as comments
- All providers (repo, service, two read use cases) are registered

### Step 8 — Create the three DTO templates

Implement `dto/create.ejs.t`, `dto/update.ejs.t`, `dto/output.ejs.t`. Verify:
- Create excludes id and behavior-managed fields
- Update uses `.partial()` delegation
- Output includes id and timestamp behavior fields

### Step 9 — Wire into `prompt.js`

Add `cleanLitePs` guard to existing `prompt.js`:

```javascript
const cleanLitePs = projectConfig?.generate?.cleanLitePs ?? false;
if (cleanLitePs) {
  const { buildCleanLitePsLocals } = await import('./clean-lite-ps/prompt-extension.js');
  Object.assign(locals, buildCleanLitePsLocals(definition, locals));
}
```

When `cleanLitePs` is false, clean-lite-ps templates emit nothing (Hygen `to:` resolves to empty string or a no-op path).

---

## Testing Strategy

### Unit Tests — `prompt-extension.js`

File: `test/clean-lite-ps/prompt-extension.test.ts`

```typescript
describe('buildCleanLitePsLocals', () => {
  it('derives correct class names from entity name', () => {});
  it('maps crm-synced family to CrmEntityRepository and CrmEntityService', () => {});
  it('maps activity family to ActivityEntityRepository and ActivityEntityService', () => {});
  it('defaults to base family when family key is absent', () => {});
  it('generates correct output paths for entity with plural name', () => {});
  it('processes belongs_to relations into BelongsToRelation shape', () => {});
  it('excludes id and behavior fields from create DTO field list', () => {});
  it('includes all fields including id in output DTO field list', () => {});
  it('derives nullable correctly for fields with nullable: true', () => {});
});
```

### Baseline Test — Contact entity

Add `test/fixtures/contact-v2.yaml` with the Contact entity definition matching the sketch:

```yaml
entity:
  name: contact
  family: crm-synced

fields:
  first_name:
    type: string
    required: true
  last_name:
    type: string
    required: true
  email:
    type: string
    required: true
  title:
    type: string
    nullable: true
  phone:
    type: string
    nullable: true
  linkedin_url:
    type: string
    nullable: true

relationships:
  belongs_to:
    - entity: account
      field: account_id
      nullable: true
    - entity: user
      field: user_id
      nullable: false

behaviors:
  - timestamps
```

Run `bun codegen entity entities/contact-v2.yaml` with `generate.cleanLitePs: true` and capture as baseline:

```bash
bun test/run-test.ts baseline
```

Verify baseline output matches the structure from the contact-module-sketch:
- `modules/contacts/contact.entity.ts` — table, relations, two type exports
- `modules/contacts/contact.repository.ts` — extends CrmEntityRepository
- `modules/contacts/contact.service.ts` — extends WithAnalytics(CrmEntityService)
- `modules/contacts/contact.controller.ts` — no repository imports
- `modules/contacts/contacts.module.ts` — exports ContactService only
- `modules/contacts/use-cases/find-contact-by-id.use-case.ts`
- `modules/contacts/use-cases/list-contacts.use-case.ts`
- `modules/contacts/dto/create-contact.dto.ts`
- `modules/contacts/dto/update-contact.dto.ts`
- `modules/contacts/dto/contact-output.dto.ts`

### TypeScript Compilation Check

The generated Contact module must pass:

```bash
cd <target-project>
bun tsc --noEmit
```

This validates that all imports resolve and types are correct. The check requires the `@shared/base-classes/*` paths to exist or be mocked with `paths` in `tsconfig.json`.

---

## Acceptance Criteria

- [ ] All 11 template files exist under `templates/entity/new/clean-lite-ps/`
- [ ] Running `bun codegen entity entities/contact-v2.yaml` with `generate.cleanLitePs: true` produces exactly the 10 output files listed in the baseline test
- [ ] Generated Contact module directory structure matches `docs/architecture/sketches/contact-module-sketch.md`
- [ ] `contact.controller.ts` contains zero imports of `*.repository.ts` files
- [ ] `contacts.module.ts` exports array contains only `ContactService`
- [ ] `contact.service.ts` class declaration uses `WithAnalytics(CrmEntityService<...>)` pattern
- [ ] `contact.entity.ts` exports both `Contact` (InferSelectModel) and `ContactInsert` ($inferInsert)
- [ ] `update-contact.dto.ts` uses `createSchema.partial()` and does not redeclare fields
- [ ] All unit tests in `test/clean-lite-ps/prompt-extension.test.ts` pass
- [ ] Baseline comparison passes: `bun test/run-test.ts compare`
- [ ] When `generate.cleanLitePs: false` (or absent), no clean-lite-ps files are emitted

---

## Constraints

- Do not modify any existing template under `templates/entity/new/backend/` or `templates/entity/new/frontend/`
- Do not modify `prompt.js` beyond the minimal guard block described in Step 9
- Family base class import paths use the `@shared/base-classes/` alias convention; do not hardcode relative paths into the templates
- Use the same `behaviorRegistry` field type mapping already present in `prompt.js` — do not duplicate the registry
