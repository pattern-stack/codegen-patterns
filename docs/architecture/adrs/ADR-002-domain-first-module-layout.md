# ADR-002 — Domain-First Module Layout

**Status:** Draft
**Date:** 2026-04-11
**Owner:** Doug
**Related:** ADR-001, ADR-003, ADR-005

## Context

The current Dealbrain backend uses a layer-first directory structure inherited from Clean Architecture:

```
apps/backend/src/
  domain/
    opportunities/
    accounts/
    contacts/
    ...
  applications/
    use-cases/            ← flat, all domains mixed
    queries/              ← flat, all domains mixed
    services/             ← ad-hoc application services
  infrastructure/
    database/repositories/
    modules/
  presentation/
    rest/
    trpc/
    facades/              ← our April attempt at a grouping layer
```

To work on the Opportunity domain, you have to touch five different directories. To understand what operations exist for Opportunity, you must scan `use-cases/`, `queries/`, `repositories/`, `controllers/`, and the facade file simultaneously. This creates several problems:

1. **Discoverability is poor.** Finding all operations for a domain requires grep, not file browsing.
2. **AI context window cost.** Generating a change touching one domain requires loading five directory listings into context. With dozens of domains, this explodes.
3. **Code review ceremony.** A single feature touches five files in five directories. Diff review jumps around the tree.
4. **Codegen complexity.** Generators must manage parallel output paths across the tree and inject into multiple monolithic barrels.
5. **No per-domain ownership.** There is no single directory a domain expert can "own."

The layer-first pattern was optimized for a world where layers change independently. In practice, layers change together — features touch every layer at once.

codegen-patterns Phase 3 (Clean-Lite) already documents a domain-first alternative. We now formalize it as the Dealbrain v2 default.

## Decision

All code for a single domain aggregate is colocated in one directory under `modules/<domain>/`. The directory contains every layer: entity (data class + Drizzle schema), repository, service, use cases, controllers, DTOs, and the NestJS module wiring.

### Directory Structure

```
apps/backend/src/
  modules/
    canonical/                        ← Canonical schemas
      opportunity/
        opportunity.canonical.yaml    ← Sales-expert field definitions
        opportunity.canonical.ts      ← Generated TS types
        opportunity.semantics.yaml    ← Measure definitions
      account/
      contact/
      activity/

    opportunities/                    ← Domain aggregate
      opportunity.entity.ts           ← Drizzle table + TS type
      opportunity.repository.ts       ← Concrete, extends CrmEntityRepository<Opportunity>
      opportunity.service.ts          ← Extends CrmEntityService<Opportunity>
      opportunity.controller.ts       ← Thin REST adapter
      opportunities.module.ts         ← NestJS wiring
      dto/
        create-opportunity.dto.ts
        update-opportunity.dto.ts
        opportunity-output.dto.ts
      use-cases/
        new-opportunity.use-case.ts
        advance-stage.use-case.ts
        assign-primary-contact.use-case.ts
        change-ownership.use-case.ts
        close-won.use-case.ts
        close-lost.use-case.ts
      tests/
        opportunity.service.spec.ts
        new-opportunity.use-case.spec.ts
        opportunity.e2e.spec.ts

    accounts/
    contacts/
    activities/
    meetings/
    emails/
    artifacts/
    facts/
    field-definitions/
    field-values/
    opportunity-updates/
    users/

    subsystems/                       ← Cross-cutting infrastructure (see ADR-008)
      cache/
      storage/
      jobs/
      events/
      broadcast/
      integrations/
      llm/
      agents/                         ← (Track C)

  shared/                             ← Cross-cutting code (see ADR-005)
    base-classes/
    errors/
    types/
    auth/
```

### Naming Conventions

- **File names:** kebab-case with dotted suffix. `opportunity.service.ts`, `create-opportunity.dto.ts`, `advance-stage.use-case.ts`.
- **Directory names:** kebab-case, plural for domain modules (`opportunities/`, `contacts/`). Canonical schemas use singular (`canonical/opportunity/`).
- **Class names:** PascalCase, match the file purpose. `OpportunityService`, `CreateOpportunityDto`, `AdvanceStageUseCase`.
- **Use case semantic naming:** Prefer business vocabulary over CRUD vocabulary. `NewOpportunity` not `CreateOpportunity`. `AdvanceStage` not `UpdateStage`. `AssignPrimaryContact` not `SetContact`. This makes use case files read like the business operations they represent.
- **Test files:** `.spec.ts` suffix. Colocated in `tests/` subdirectory of each module (not in a global `test/` tree).

### Module Barrel Exports

Each domain module exports a NestJS module (`opportunities.module.ts`) that wires its controller, services, repositories, and use cases. The root `AppModule` imports domain modules directly — no intermediate barrel files.

The `modules/<domain>/index.ts` file exports the public symbols (service, controller, module, entity type, DTO types) for consumption by other modules. Internal details (repository, use case internals) stay unexported.

### Migration Markers

During the transition period of Track B, existing domains live at their old paths and new domains live under `modules/`. An ESLint configuration uses the `modules/` prefix to identify "migrated" code and apply strict layer rules only to that code. Legacy paths are exempt.

Once all domains are migrated, the legacy paths are deleted and the ESLint exemption is removed.

## Consequences

### Positive

- **One domain = one directory.** Opportunity lives in `modules/opportunities/`. Full stop.
- **Discoverability is trivial.** Browse `modules/opportunities/` to see every operation. No grep required.
- **AI context window efficient.** Generating changes for a domain loads one directory. Dozens of domains do not compound context costs.
- **Review-friendly diffs.** A feature touches one directory. PR diffs are contiguous.
- **Codegen clean.** Templates generate into `modules/<domain>/` with one injector target (the domain's module file). No more cross-tree path management.
- **Clear ownership.** A domain expert owns one directory.
- **Canonical schemas anchor domains.** `modules/canonical/opportunity/` is the schema source of truth that `modules/opportunities/` references.

### Negative

- **Breaks Clean Architecture orthodoxy.** Clean (Uncle Bob's original model) insists on layer-first separation. Some team members may object on principle. The counter-argument: this is still Clean Architecture — the layers are present and enforced, they are just collocated by domain instead of separated by layer.
- **Imports within a domain are always relative.** `./opportunity.repository` instead of `@backend/infrastructure/repositories/opportunity.repository`. Mixing relative and alias imports in one codebase can be confusing.
- **Migration churn during Track B.** For a period, the codebase has both `modules/opportunities/` and the legacy `domain/opportunities/ + applications/use-cases/ + infrastructure/repositories/`. This is transitional.
- **Cross-domain dependencies are visible but not automatically detected.** ESLint rules must catch them (see ADR-004).

### Neutral

- Subsystems and shared code live at the top level, NOT under `modules/`. `subsystems/` is separate because it is cross-cutting infrastructure, not a domain aggregate. `shared/` is separate because base classes and utilities are not domain-bound.
- The `modules/canonical/` directory is special — it holds schema definitions, not code that runs. It is colocated with `modules/` rather than under `shared/` because it is conceptually part of the domain layer (sales expertise defines canonical schemas).

## Alternatives Considered

### Alternative 1 — Keep layer-first

Reject domain-first, stick with `domain/`, `applications/`, `infrastructure/`, `presentation/`.

**Rejected because:** This is the status quo that motivated the rebuild. See Context above.

### Alternative 2 — Hybrid: domain directories inside layer directories

`domain/opportunities/`, `applications/use-cases/opportunities/`, `infrastructure/repositories/opportunities/`, etc.

**Rejected because:**
- All the navigation cost of layer-first plus the ceremony of maintaining domain subdirectories.
- Doesn't solve the discoverability problem — you still jump between five directories to see one domain.
- codegen-patterns would need to manage even more parallel output paths.

### Alternative 3 — Feature-slice architecture (flat feature folders)

Each HTTP endpoint or use case gets its own folder with everything it needs inline, duplicating code rather than sharing via domain services.

**Rejected because:**
- Loses the DDD aggregate benefit. Sales expertise about opportunities would scatter across feature folders.
- Cross-cutting domain logic (semantic measures, stage transition rules) has no natural home.
- Duplication over sharing is the wrong tradeoff for a business logic-heavy app.

### Alternative 4 — Place canonical schemas under `shared/`

Move `modules/canonical/` to `shared/canonical/`.

**Partially considered.** The argument for `shared/` is that canonical schemas are cross-cutting. The argument for `modules/` is that they are part of the domain layer conceptually and referenced primarily by domain modules. Open question — tracked in v2 overview.

## References

- [ADR-001 — DDD + hexagonal architecture](./ADR-001-ddd-hexagonal-architecture.md)
- [ADR-003 — Service vs use case boundary rules](./ADR-003-service-vs-use-case-boundary.md)
- [ADR-005 — Entity-family base class inheritance tree](./ADR-005-entity-family-base-classes.md)
- [codegen-patterns CODEGEN-EVOLUTION-PLAN.md — Phase 3 (Clean-Lite)](../CODEGEN-EVOLUTION-PLAN.md)
- [v2 Initiative Overview](../v2-initiative-overview.md)
