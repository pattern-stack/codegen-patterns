---
name: entities
description: >-
  Load when authoring or changing an entity definition for a project that uses
  @pattern-stack/codegen — creating `entities/<name>.yaml`, choosing an entity
  family (Synced / Activity / Metadata / Knowledge / Base), adding fields,
  behaviors, relationships, declarative `queries:`, or opting an entity into EAV
  custom fields. Covers what each YAML block generates and the layer rules the
  generated code obeys.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: false
---

<!-- managed by @pattern-stack/codegen — re-run `codegen skills install` to refresh. Edit the package source, not this vendored copy. -->

# Authoring entities

An entity is one `entities/<name>.yaml` file. Running `codegen entity new
entities/<name>.yaml` (or `codegen entity new --all`) turns it into a full
vertical slice: a Drizzle table, a repository (extending a family base class), a
service, use cases, a controller with Zod-validated routes, DTOs, and a NestJS
module — plus an entry in the `GENERATED_MODULES` and schema barrels.

## Mental model

- **One YAML → one module.** You describe *what* the entity is (fields,
  relationships, behaviors, queries); the templates produce the *how* (CRUD,
  validation, wiring).
- **Family = inherited capability.** Every entity picks a `pattern` (family).
  The family decides which extra repository/service methods you get for free on
  top of the standard CRUD set. See `families-and-queries.md`.
- **Declarative queries beat hand-written finders.** A `queries:` block
  generates typed repository methods, interface signatures, injectable query
  use cases, and module registration. See `families-and-queries.md`.
- **Naming**: YAML is `snake_case` (matches DB columns); generated TS
  properties are `camelCase`; entity `name` is singular `snake_case`.

## Routing

| For | Read |
|---|---|
| The full YAML block reference — fields, types, behaviors, relationships, EAV flags, `generate:` | `yaml-reference.md` |
| Choosing a family, the methods each family adds, and the `queries:` block shapes | `families-and-queries.md` |

## Minimum viable entity

```yaml
entity:
  name: account            # singular snake_case
  pattern: Synced          # Base | Synced | Activity | Metadata | Knowledge (or app-defined)

fields:
  name:
    type: string
    required: true
  email:
    type: string
    index: true
  status:
    type: enum
    choices: [active, inactive]

behaviors:
  - timestamps             # createdAt, updatedAt
  - soft_delete            # deletedAt + automatic query filtering

queries:
  - by: [email]
    unique: true           # → FindAccountByEmail use case (unique)
```

```bash
codegen entity new entities/account.yaml
# barrels auto-update — no manual wiring for the new module
```

## Layer rules the generated code obeys

Generated code is layered; your hand-written use cases must respect the same
boundaries:

- **Repository** — single table. Extends a family base. No business logic.
  Write methods take an optional `tx?: DrizzleTx`.
- **Service** — one aggregate. Composes repositories; may read cross-domain;
  may call same-domain services. **May NOT write cross-domain.** This is the
  mandatory API boundary.
- **Use case** — a workflow. Composes services (including cross-domain), owns
  the transaction for cross-domain writes, emits events, calls external ports.
- **Controller** — thin adapter. Calls use cases only. `@Body()` is run through
  `ZodValidationPipe` (422 on failure); `GET :id` throws 404 when the row is
  missing or soft-deleted.

## Non-obvious rules

- **`generate.writes: true` (default) emits POST/PATCH/DELETE** + create/update/
  delete use cases. Set it `false` for read-only entities.
- **Cross-entity references must resolve.** If `account.yaml` references
  `contact`, the analyzer needs `contact.yaml` present; `codegen entity new
  --all` is the safe way to regenerate a set with cross-refs.
- **Regenerating is safe and idempotent.** Re-run after any YAML edit; the
  module tree + barrels are codegen-owned.
- **Validate before generating** when unsure: `codegen entity validate --strict`.

## Do not

- **Do not hand-edit generated module files.** Override by composing in your own
  module / subclassing the generated service.
- **Do not put business logic in a repository** or cross-domain writes in a
  service — the layer rules above are enforced by convention and reviewed.
- **Do not invent field types.** Use the documented set (`yaml-reference.md`);
  unknown types fail validation.
