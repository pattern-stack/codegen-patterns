# Spec A7 — Wiring Templates

**Status:** Approved for implementation
**Issue:** A7
**Depends on:** A6 (clean-lite-ps template set)
**Related ADRs:** ADR-002, ADR-003
**Reference output:** `docs/architecture/sketches/contact-module-sketch.md`

---

## Overview

Three additional templates that wire generated modules into the running NestJS application. These templates handle:

1. Injecting the new module's import statement into `app.module.ts`
2. Injecting the new module into AppModule's `imports` array
3. Generating a barrel `index.ts` per module that exports only public symbols

Like A6, all templates are guarded by `generate.cleanLitePs: true`. When the flag is absent or false, every template emits nothing.

---

## Files to Create

| File | Action | Description |
|------|--------|-------------|
| `templates/entity/new/clean-lite-ps/_inject-app-module-import.ejs.t` | create | Injects import statement into app.module.ts |
| `templates/entity/new/clean-lite-ps/_inject-app-module-array.ejs.t` | create | Injects module into AppModule imports array |
| `templates/entity/new/clean-lite-ps/index.ejs.t` | create | Barrel exports for module public surface |

No existing files are modified by this spec beyond the two injection targets in `app.module.ts` (which are modified at generation time, not at implementation time).

---

## Interface Definitions

All locals from A6's `CleanLitePsLocals` are available. The following additional locals are needed:

```typescript
interface WiringLocals {
  // Derived from entityNamePluralPascal
  moduleName: string;         // "ContactsModule"
  moduleImportPath: string;   // "./modules/contacts/contacts.module"

  // Path to the target app module file (from config or convention)
  appModulePath: string;      // "src/app.module.ts" (configurable)

  // Cross-domain imports from belongs_to relationships
  // (same BelongsToRelation[] from A6, used to derive cross-module imports in index)
  belongsTo: BelongsToRelation[];

  // Class names mirror A6 classNames
  classNames: CleanLitePsLocals['classNames'];
}
```

The `appModulePath` is read from `codegen.config.yaml` under `paths.app_module`, defaulting to `src/app.module.ts`.

---

## Template Specifications

### 1. `_inject-app-module-import.ejs.t`

**Purpose:** Injects the module import statement into `app.module.ts` after a marker comment.

**Hygen header:**

```
---
to: <%= appModulePath %>
inject: true
skip_if: "from './<%= moduleImportPath %>'"
after: "// Codegen module imports"
---
import { <%= moduleName %> } from './<%= moduleImportPath %>';
```

**Marker convention:** `app.module.ts` must contain the line `// Codegen module imports` as the injection anchor. The `skip_if` guard prevents duplicate injection if the module is already imported.

**Example `app.module.ts` setup required before first codegen run:**

```typescript
import { Module } from '@nestjs/common';
// Codegen module imports

@Module({
  imports: [
    // Codegen modules
  ],
})
export class AppModule {}
```

**Resulting file after generating contacts:**

```typescript
import { Module } from '@nestjs/common';
// Codegen module imports
import { ContactsModule } from './modules/contacts/contacts.module';

@Module({
  imports: [
    // Codegen modules
    ContactsModule,
  ],
})
export class AppModule {}
```

**Constraints:**
- `skip_if` must match a substring present in the injected line — use the import path fragment, not the full line
- The anchor comment `// Codegen module imports` must be on its own line in the target file
- Hygen's `after:` places injection on the line immediately following the anchor

---

### 2. `_inject-app-module-array.ejs.t`

**Purpose:** Injects the module class name into AppModule's `imports` array.

**Hygen header:**

```
---
to: <%= appModulePath %>
inject: true
skip_if: "<%= moduleName %>,"
after: "// Codegen modules"
---
    <%= moduleName %>,
```

**Marker convention:** AppModule's `imports` array must contain `// Codegen modules` as a line within the array body. The four-space indent on the injected line matches standard NestJS formatting.

**Constraints:**
- `skip_if` checks for `<ModuleName>,` to prevent duplicate array entries
- The anchor comment `// Codegen modules` must be inside the `imports: [...]` array body
- Both this template and `_inject-app-module-import.ejs.t` target the same file; Hygen processes them sequentially

---

### 3. `index.ejs.t`

**Output path:** `modules/<plural>/index.ts`

**Hygen header:**

```
---
to: modules/<%= entityNamePlural %>/index.ts
force: true
---
```

**Content structure:**

```typescript
// Public surface for the <%= entityNamePluralPascal %> module.
// Internal details (repository, use cases) are not exported — consumers depend on the service only.

export { <%= classNames.module %> } from './<%= entityNamePlural %>.module';
export { <%= classNames.service %> } from './<%= entityName %>.service';
export { <%= classNames.controller %> } from './<%= entityName %>.controller';

// Type-only exports — no runtime dependency on entity or DTO implementations
export type { <%= classNames.entity %>, <%= classNames.entity %>Insert } from './<%= entityName %>.entity';
export type { <%= classNames.createDto %> } from './dto/create-<%= entityName %>.dto';
export type { <%= classNames.updateDto %> } from './dto/update-<%= entityName %>.dto';
export type { <%= classNames.outputDto %> } from './dto/<%= entityName %>-output.dto';
```

**Export rules (per ADR-002):**

| Symbol | Exported | Export style |
|--------|----------|-------------|
| `<Entity>Module` | Yes | value export |
| `<Entity>Service` | Yes | value export |
| `<Entity>Controller` | Yes | value export |
| `<Entity>` type | Yes | `export type` only |
| `<Entity>Insert` type | Yes | `export type` only |
| `Create<Entity>Dto` type | Yes | `export type` only |
| `Update<Entity>Dto` type | Yes | `export type` only |
| `<Entity>OutputDto` type | Yes | `export type` only |
| `<Entity>Repository` | No | internal — not exported |
| `Find<Entity>ByIdUseCase` | No | internal — not exported |
| `List<Entities>UseCase` | No | internal — not exported |

The repository is an internal implementation detail. Use cases are internal to the module and not part of the cross-domain public API. Other domain modules that need to trigger behavior compose through the service (reads) or via their own use case calling this module's service. They never import this module's use cases directly.

---

## Cross-Domain Import Logic

For entities that have `belongs_to` relationships, the generated module needs to import the related entity's NestJS module. This is handled in A6's `module.ejs.t` (as commented stubs). In A7, the `index.ejs.t` does NOT re-export related module imports — those are the consuming module's concern.

However, when generating a module that depends on related modules, the wiring templates must ensure the related module is importable. The path convention for cross-domain module imports is:

```typescript
// Relative path from current module's module.ts to the related module file:
import { AccountsModule } from '../accounts/accounts.module';
import { UsersModule } from '../users/users.module';
```

This pattern is generated in A6's `module.ejs.t`. A7's templates do not need to handle cross-domain imports — they only wire the current module into `app.module.ts`.

---

## Architecture Mode Guard

All three templates in A7 check the `generate.cleanLitePs` flag before emitting output. The guard is implemented in the Hygen `to:` header using a conditional:

```ejs
---
to: <%- cleanLitePs ? 'modules/' + entityNamePlural + '/index.ts' : '' %>
force: true
---
```

When `cleanLitePs` is false, Hygen receives an empty `to:` path. Hygen skips files with empty `to:` paths without error.

The injection templates use the same guard on their `to:` path:

```ejs
---
to: <%- cleanLitePs ? appModulePath : '' %>
inject: true
skip_if: ...
after: ...
---
```

---

## `app.module.ts` Setup Requirements

Before any module can be wired in, `app.module.ts` must contain both marker comments:

```typescript
import { Module } from '@nestjs/common';
// Codegen module imports        ← injection anchor for import statements

@Module({
  imports: [
    // Codegen modules           ← injection anchor for module array entries
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
```

These comments are the sole coupling between the wiring templates and the host project's `AppModule`. The codegen does not parse or rewrite the module decorator — it only appends lines at the anchors.

If either marker is missing, Hygen silently skips injection (the `after:` target is not found). This is acceptable behavior for projects that manage `AppModule` manually — they simply omit the markers and register modules by hand.

---

## Implementation Steps

### Step 1 — Create `_inject-app-module-import.ejs.t`

Implement with the correct `skip_if`, `after`, `inject: true`, and guarded `to:` path. Test by running codegen against a minimal `app.module.ts` fixture that contains both markers.

### Step 2 — Create `_inject-app-module-array.ejs.t`

Implement in the same pattern. Verify the injected line uses consistent indentation (four spaces) matching standard NestJS formatting.

### Step 3 — Create `index.ejs.t`

Implement the barrel file. Pay attention to:
- `export type` (not bare `export`) for entity and DTO types
- Repository and use case classes must NOT appear in any export
- Insert the module-scoping comment at the top

### Step 4 — Extend `prompt-extension.js` with wiring locals

Add `appModulePath`, `moduleName`, and `moduleImportPath` derivation to the `buildCleanLitePsLocals` function from A6. `moduleImportPath` must be a relative path from `appModulePath`'s directory to the module file, without `.ts` extension.

### Step 5 — Verify injection idempotency

Run codegen twice against the same `app.module.ts` fixture. The second run must produce identical file contents — no duplicate imports or array entries.

---

## Testing Strategy

### Unit Tests — wiring locals derivation

File: `test/clean-lite-ps/wiring-locals.test.ts`

```typescript
describe('wiring locals derivation', () => {
  it('derives moduleImportPath as relative path from app module location', () => {});
  it('defaults appModulePath to src/app.module.ts when not configured', () => {});
  it('reads appModulePath from codegen.config.yaml paths.app_module', () => {});
  it('derives moduleName as PluralPascal + Module suffix', () => {});
});
```

### Integration Test — injection idempotency

File: `test/clean-lite-ps/wiring-injection.test.ts`

```typescript
describe('app.module.ts injection', () => {
  it('injects import statement after // Codegen module imports marker', () => {});
  it('injects module name into imports array after // Codegen modules marker', () => {});
  it('does not inject duplicate import when codegen runs twice', () => {});
  it('does not inject duplicate array entry when codegen runs twice', () => {});
  it('skips injection when // Codegen module imports marker is absent', () => {});
});
```

Use a temporary `app.module.ts` fixture for each test. Assert file contents after each codegen run.

### Baseline Test — barrel index

File: `test/clean-lite-ps/index-barrel.test.ts`

```typescript
describe('index.ts barrel export', () => {
  it('exports module, service, and controller as value exports', () => {});
  it('exports entity and DTO types as type-only exports', () => {});
  it('does not export repository', () => {});
  it('does not export use cases', () => {});
});
```

Parse the generated `modules/contacts/index.ts` from the contact-v2.yaml baseline run and assert on the export list.

### Full Baseline Run

After implementing all three templates, run the full baseline:

```bash
bun test/run-test.ts baseline
```

Verify the contact-v2.yaml baseline now includes `modules/contacts/index.ts` in the output.

---

## Acceptance Criteria

- [ ] `_inject-app-module-import.ejs.t` injects exactly one import line after `// Codegen module imports`
- [ ] `_inject-app-module-array.ejs.t` injects exactly one array entry after `// Codegen modules`
- [ ] Running codegen twice produces identical `app.module.ts` contents (idempotency)
- [ ] `index.ts` barrel exports `ContactsModule`, `ContactService`, `ContactController` as value exports
- [ ] `index.ts` barrel exports `Contact`, `ContactInsert`, `CreateContactDto`, `UpdateContactDto`, `ContactOutputDto` as `export type` (not value exports)
- [ ] `index.ts` does NOT export `ContactRepository`, `FindContactByIdUseCase`, or `ListContactsUseCase`
- [ ] When `generate.cleanLitePs: false`, all three templates emit no files and do not modify `app.module.ts`
- [ ] When `app.module.ts` lacks the marker comments, injection silently skips without error
- [ ] All unit and integration tests pass
- [ ] Baseline comparison passes: `bun test/run-test.ts compare`

---

## Constraints

- Do not modify any files in `templates/entity/new/backend/` or `templates/entity/new/frontend/`
- Do not add logic to parse or rewrite the `@Module()` decorator — use marker-comment injection only
- The `// Codegen module imports` and `// Codegen modules` marker strings are fixed — do not make them configurable (would add indirection with no benefit)
- `moduleImportPath` in the injection templates must use forward slashes on all platforms (Hygen runs on darwin, linux, and Windows)
- The barrel `index.ts` must use `export type` for entity and DTO types to avoid circular dependency issues at runtime and to signal intent: downstream modules must not take a runtime dependency on the DTO implementation modules
