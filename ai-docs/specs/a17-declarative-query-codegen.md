# SPEC-A17: Declarative Query Code Generation from YAML `queries:` Block

**Status:** Approved  
**Date:** 2026-04-12  
**Depends on:** Schema/parser work (SPEC-002) — `QueryDeclarationSchema` in `schema/entity-definition.schema.ts` and `ParsedQuery` in `analyzer/types.ts` are already defined.

---

## Purpose

The `queries:` block in entity YAML is parsed but not yet used by the template system. This spec covers the template-side implementation: generating Drizzle repository methods, service pass-throughs, and use case classes from `processedQueries[]` that is passed into Hygen templates via `prompt.js`.

The goal is that `contact-v2.yaml`'s six query declarations all produce correct, compilable TypeScript with no hand-writing required.

---

## Files to Create or Modify

| File | Action | Notes |
|------|--------|-------|
| `templates/entity/new/prompt.js` | modify | Derive `processedQueries` array from parsed `queries:` YAML block |
| `templates/entity/new/backend/database/repository.ejs.t` | modify | Append declarative query methods after existing FK-based methods |
| `templates/entity/new/backend/application/queries/declarative-queries.ejs.t` | create | New template: one use case class per declared query, all in one file |
| `templates/entity/new/backend/modules/core/module.ejs.t` | modify | Register declarative query classes in providers + exports |
| `test/fixtures/contact-v2.yaml` | read-only reference | Source of truth for the six queries to exercise |
| `test/baseline/` | modify (re-baseline) | Run `bun test/run-test.ts baseline` after implementation |

---

## Background: The Six Queries in contact-v2.yaml

```yaml
queries:
  - by: [user_id]
  - by: [email]
    unique: true
  - by: [account_id]
    order: created_at desc
  - by: [user_id, account_id]
  - by: [opportunity_id]
    via: opportunity_contact_link
  - by: [opportunity_id]
    select: [email]
    via: opportunity_contact_link
```

These map to the `ParsedQuery` type from `analyzer/types.ts`:

```typescript
interface ParsedQuery {
  by: string[];
  unique?: boolean;
  select?: string[];
  order?: string;
  limit?: boolean;
  via?: string;
}
```

---

## Implementation Steps

### Step 1: Derive `processedQueries` in `prompt.js`

In `prompt.js`, after the entity YAML is loaded and the fields map is built, add a function that transforms the raw `queries` array into a richer `processedQueries` array. Each element in `processedQueries` provides everything the templates need — method names, return types, Drizzle import hints — without requiring logic inside EJS.

**Naming rules** (all fields converted snake_case → camelCase):

| Declaration | Method name |
|-------------|-------------|
| `by: [user_id]` | `findByUserId` |
| `by: [email], unique: true` | `findByEmail` |
| `by: [account_id], order: created_at desc` | `findByAccountId` |
| `by: [user_id, account_id]` | `findByUserIdAndAccountId` |
| `by: [opportunity_id], via: opportunity_contact_link` | `findByOpportunityId` |
| `by: [opportunity_id], select: [email], via: opportunity_contact_link` | `findEmailsByOpportunityId` |

**Naming algorithm** (pseudocode):
```
function buildMethodName(query):
  if query.select and query.select.length > 0:
    selectedPart = toCamelCase(query.select.join('_and_'))  // "email" → "Emails"
    byPart = toCamelCase(query.by.join('_and_'))            // "opportunity_id" → "OpportunityId"
    return "find" + capitalize(selectedPart) + "sBy" + byPart
  else:
    byPart = toCamelCase(query.by.join('_and_'))
    return "findBy" + byPart
```

Note: `findEmails...` uses plural because `select` implies a projection returning multiple values.

**Return type rules**:

| Condition | Repository return type | Service return type |
|-----------|----------------------|---------------------|
| Default (no `unique`, no `select`) | `ClassName[]` | `ClassName[]` |
| `unique: true` | `ClassName \| null` | `ClassName \| null` |
| `select: [field]` (single field) | `string[]` (or appropriate TS type) | `string[]` |
| `limit: true` | adds paginated variant (see below) | adds paginated variant |

**`processedQuery` object shape** (what `prompt.js` produces for each query):

```typescript
{
  // Derived names
  methodName: string,           // "findByUserId"
  paginatedMethodName: string,  // "findByUserIdPaginated" (only if limit: true)
  useCaseClassName: string,     // "FindContactsByUserIdQuery" (PascalCase)

  // Parameters for the method signature
  params: Array<{
    name: string,               // "userId"
    tsType: string,             // "string"
    drizzleField: string,       // "user_id" (original snake_case for Drizzle column access)
  }>,

  // Return type
  returnType: string,           // "Contact[]", "Contact | null", "string[]"
  isUnique: boolean,
  hasSelect: boolean,
  selectFields: string[],       // camelCase field names, e.g. ["email"]
  selectDrizzleFields: string[],// snake_case, e.g. ["email"] (same for simple fields)

  // Ordering
  orderBy: string | null,       // "created_at" (snake_case field)
  orderDirection: 'asc' | 'desc' | null,

  // Pagination
  hasLimit: boolean,

  // Junction table join
  hasVia: boolean,
  viaTable: string | null,      // "opportunity_contact_link"
  viaTableCamel: string | null, // "opportunityContactLink"
  viaJoinCondition: string | null, // hint for template: "contact_id = contacts.id"

  // Drizzle imports needed by this query
  drizzleImports: string[],     // e.g. ["eq", "and", "desc", "inArray"]
}
```

For `via` queries, the template implementer must decide how to express the join condition. The simplest approach: document that `via` queries use `db.select().from(table).innerJoin(viaTable, eq(viaTable.contactId, table.id)).where(eq(viaTable.opportunityId, value))`. The `prompt.js` should provide `viaTable` and `viaTableCamel` strings; the EJS template handles the join expression.

**Collect all Drizzle imports needed across all queries** and merge them with the existing `drizzleImports` array so the `_inject-schema-server-imports` template picks them up. Additions include: `and`, `desc`, `asc`, `inArray` (if needed), plus `sql` for raw junction queries if the template uses that approach.

---

### Step 2: Modify `repository.ejs.t` — Append Declarative Query Methods

After the existing `belongsToRelations` and `entityRefFields` method blocks (and before the closing `}`), append a new loop block for `processedQueries`.

**Pseudocode for each query type in EJS:**

**Simple (single field, no via, no unique):**
```typescript
async findByUserId(userId: string): Promise<Contact[]> {
  const records = await this.baseQuery()
    .where(eq(contacts.userId, userId));
  return records.map(Contact.fromRecord);
}
```

**Multi-field:**
```typescript
async findByUserIdAndAccountId(userId: string, accountId: string): Promise<Contact[]> {
  const records = await this.baseQuery()
    .where(and(
      eq(contacts.userId, userId),
      eq(contacts.accountId, accountId),
    ));
  return records.map(Contact.fromRecord);
}
```

**Unique (returns T | null):**
```typescript
async findByEmail(email: string): Promise<Contact | null> {
  const result = await this.baseQuery()
    .where(eq(contacts.email, email))
    .limit(1);
  const record = result[0];
  return record ? Contact.fromRecord(record) : null;
}
```

**With order:**
```typescript
async findByAccountId(accountId: string): Promise<Contact[]> {
  const records = await this.baseQuery()
    .where(eq(contacts.accountId, accountId))
    .orderBy(desc(contacts.createdAt));
  return records.map(Contact.fromRecord);
}
```

**With limit (paginated variant — generated in addition to the base method):**
```typescript
async findByXPaginated(x: string, limit: number, offset: number): Promise<Contact[]> {
  const records = await this.baseQuery()
    .where(eq(contacts.x, x))
    .limit(limit)
    .offset(offset);
  return records.map(Contact.fromRecord);
}
```

**Via junction table (returns entity rows):**
```typescript
async findByOpportunityId(opportunityId: string): Promise<Contact[]> {
  const records = await this.db
    .select()
    .from(contacts)
    .innerJoin(
      opportunityContactLink,
      eq(opportunityContactLink.contactId, contacts.id),
    )
    .where(eq(opportunityContactLink.opportunityId, opportunityId));
  return records.map((r) => Contact.fromRecord(r.contacts));
}
```

Note: `r.contacts` is the shape Drizzle returns when using `.innerJoin` with named tables — the select result is namespaced by table. Verify this against the Drizzle version in use.

**Via junction table with select projection (returns scalar array):**
```typescript
async findEmailsByOpportunityId(opportunityId: string): Promise<string[]> {
  const rows = await this.db
    .select({ email: contacts.email })
    .from(contacts)
    .innerJoin(
      opportunityContactLink,
      eq(opportunityContactLink.contactId, contacts.id),
    )
    .where(eq(opportunityContactLink.opportunityId, opportunityId));
  return rows.map((r) => r.email);
}
```

**EJS template structure (append inside repository class, both base_class and inline branches):**
```ejs
<% if (processedQueries && processedQueries.length > 0) { -%>

  // ═══════════════════════════════════════════════════════════════════════
  // Declarative queries (generated from YAML queries: block)
  // ═══════════════════════════════════════════════════════════════════════
<% processedQueries.forEach((q) => { -%>

  async <%= q.methodName %>(<%= q.params.map(p => `${p.name}: ${p.tsType}`).join(', ') %>): Promise<<%= q.returnType %>> {
<%   if (q.hasVia && q.hasSelect) { -%>
    // junction + projection
<%   } else if (q.hasVia) { -%>
    // junction join
<%   } else if (q.isUnique) { -%>
    // unique — returns T | null
<%   } else { -%>
    // standard multi-where
<%   } -%>
    // ... (see method pseudocode above for each case)
  }
<% if (q.hasLimit) { -%>

  async <%= q.paginatedMethodName %>(<%= q.params.map(p => `${p.name}: ${p.tsType}`).join(', ') %>, limit: number, offset: number): Promise<<%= q.returnType %>> {
    // paginated variant
  }
<% } -%>
<% }) -%>
<% } -%>
```

The `via` table import (e.g., `opportunityContactLink`) must be derived in `prompt.js` and added to the imports list. The junction table is assumed to live in the same Drizzle schema file as the main entity. If it does not exist yet, the generated code will fail to compile — document this in a comment.

---

### Step 3: Create `declarative-queries.ejs.t` — Use Case Classes

Generate a single file containing one `@Injectable()` class per declared query. This avoids proliferating files while keeping each class testable.

**File location rule:**
```
to: <%= generate.queries && processedQueries.length > 0
       ? `${basePaths.backendSrc}/${paths.queries}/${name}/declarative-queries.ts`
       : '' %>
```

Use the same `outputPaths.listQuery` path conventions from `prompt.js` as a reference for the `paths.queries` segment.

**Generated file shape:**

```typescript
/**
 * Declarative Queries — <%= classNamePlural %>
 * Generated from YAML queries: block. Do not edit directly.
 */

import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { <%= repositoryToken %> } from '<%= imports.constants %>';
import type { I<%= className %>Repository } from '<%= imports.domain %>';
import { <%= className %> } from '<%= imports.domain %>';

// ─── FindContactsByUserIdQuery ─────────────────────────────────────────────

@Injectable()
export class FindContactsByUserIdQuery {
  constructor(
    @Inject(<%= repositoryToken %>)
    private readonly <%= camelName %>Repository: I<%= className %>Repository,
  ) {}

  async execute(userId: string): Promise<Contact[]> {
    return this.<%= camelName %>Repository.findByUserId(userId);
  }
}

// ─── FindContactByEmailQuery ───────────────────────────────────────────────

@Injectable()
export class FindContactByEmailQuery {
  constructor(
    @Inject(<%= repositoryToken %>)
    private readonly <%= camelName %>Repository: I<%= className %>Repository,
  ) {}

  async execute(email: string): Promise<Contact | null> {
    return this.<%= camelName %>Repository.findByEmail(email);
  }
}

// ... one class per processedQuery ...
```

**Use case class naming convention:**

| `methodName` | `useCaseClassName` |
|---|---|
| `findByUserId` | `FindContactsByUserIdQuery` |
| `findByEmail` (unique) | `FindContactByEmailQuery` (singular, no `s`) |
| `findByAccountId` | `FindContactsByAccountIdQuery` |
| `findByUserIdAndAccountId` | `FindContactsByUserIdAndAccountIdQuery` |
| `findByOpportunityId` (via) | `FindContactsByOpportunityIdQuery` |
| `findEmailsByOpportunityId` (select) | `FindContactEmailsByOpportunityIdQuery` |

Rule: prefix `Find`, entity name pluralized (singular for unique), `By` + field(s) in PascalCase, suffix `Query`. For select projections, insert the selected field name(s) between entity name and `By`.

**Export an index** at the bottom of the file so the module can import cleanly:
```typescript
export const declarativeQueryClasses = [
  FindContactsByUserIdQuery,
  FindContactByEmailQuery,
  // ...
] as const;
```

The module template uses `declarativeQueryClasses` spread into providers and exports.

---

### Step 4: Modify `module.ejs.t` — Register Declarative Query Classes

Add a conditional import and spread of `declarativeQueryClasses` into the module:

```ejs
<% if (processedQueries && processedQueries.length > 0) { -%>
import { declarativeQueryClasses } from '<%= imports.moduleToDeclarativeQueries %>';
<% } -%>
```

In the `providers` and `exports` arrays:
```ejs
    // Declarative queries (from YAML queries: block)
<% if (processedQueries && processedQueries.length > 0) { -%>
    ...declarativeQueryClasses,
<% } -%>
```

The import path `imports.moduleToDeclarativeQueries` must be derived in `prompt.js` following the same relative-path convention used for `imports.moduleToGetByIdQuery`.

---

## Drizzle Import Tracking

The `processedQueries` derivation in `prompt.js` must merge any new Drizzle imports into the existing `drizzleImports` array used by the inject templates. Required additions per query type:

| Query type | Additional imports |
|---|---|
| Any multi-field `by` | `and` |
| `order: ... desc` | `desc` |
| `order: ... asc` | `asc` |
| `via` (junction) | `innerJoin` is a method call, not an import; but `eq` already imported |
| Unique | no new imports (uses `limit(1)`) |

Deduplicate before passing to the inject template. The `drizzleImports` array already contains `eq` and `isNull` (from soft delete); do not add duplicates.

---

## Repository Interface

The generated repository methods must also appear in the `IContactRepository` interface. The `repository-interface.ejs.t` template (in `templates/entity/new/backend/domain/`) must be modified with the same `processedQueries` loop to emit method signatures.

**Interface method signatures:**

```typescript
findByUserId(userId: string): Promise<Contact[]>;
findByEmail(email: string): Promise<Contact | null>;
findByAccountId(accountId: string): Promise<Contact[]>;
findByUserIdAndAccountId(userId: string, accountId: string): Promise<Contact[]>;
findByOpportunityId(opportunityId: string): Promise<Contact[]>;
findEmailsByOpportunityId(opportunityId: string): Promise<string[]>;
```

This is required for the `I<%= className %>Repository` contract that use case classes depend on via `@Inject`.

---

## Testing Strategy

### Baseline Test

After implementing all templates, run:
```bash
bun codegen entity test/fixtures/contact-v2.yaml
bun test/run-test.ts baseline
```

This captures the new generated output as the new baseline. Subsequent runs of `bun test/run-test.ts full` will catch regressions.

### Compile Check

The generated output must pass TypeScript compilation. A minimal compile check:
```bash
cd gen/contacts && tsc --noEmit
```

This requires a `tsconfig.json` in `gen/contacts/` or the repo root tsconfig covering that path.

### Manual Verification of Each Query

After running codegen on `contact-v2.yaml`, inspect the generated repository and confirm each of the following methods is present and uses the correct Drizzle pattern:

| Method | Pattern to verify |
|--------|------------------|
| `findByUserId` | `baseQuery().where(eq(contacts.userId, userId))` |
| `findByEmail` | `.limit(1)`, returns `Contact \| null` |
| `findByAccountId` | `.orderBy(desc(contacts.createdAt))` |
| `findByUserIdAndAccountId` | `and(eq(...), eq(...))` |
| `findByOpportunityId` | `.innerJoin(opportunityContactLink, ...)` |
| `findEmailsByOpportunityId` | `.select({ email: contacts.email })`, returns `string[]` |

---

## Acceptance Criteria

- [ ] `prompt.js` exports a `processedQueries` array when the YAML has a `queries:` block; exports an empty array or `undefined` when absent (backward compatible — no regressions on existing entity YAMLs)
- [ ] Running `bun codegen entity test/fixtures/contact-v2.yaml` generates all six repository methods in `contact.repository.ts`
- [ ] Junction table queries use `.innerJoin()`, not raw SQL
- [ ] Unique queries return `T | null` (not `T[]`)
- [ ] Paginated variant is generated when `limit: true` is present on a query declaration
- [ ] Select-projection queries return `string[]` (or typed scalar array), not entity arrays
- [ ] `declarative-queries.ts` is generated with one `@Injectable()` class per declared query
- [ ] All six classes appear in the `ContactsModule` providers and exports
- [ ] `IContactRepository` interface includes all six method signatures
- [ ] Existing entity YAMLs without a `queries:` block generate identical output to pre-implementation baseline (no regressions)
- [ ] `bun test/run-test.ts full` passes after re-baselining with `contact-v2.yaml` added to the fixture set
