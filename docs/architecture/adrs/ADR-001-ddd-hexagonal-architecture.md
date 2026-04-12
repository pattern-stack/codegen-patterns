# ADR-001 — Adopt DDD + Hexagonal Architecture for Dealbrain Backend

**Status:** Draft
**Date:** 2026-04-11
**Owner:** Doug
**Supersedes:** informal Clean Architecture adoption

## Context

The current Dealbrain backend nominally follows Clean Architecture with `domain/`, `applications/`, `infrastructure/`, and `presentation/` layers. In practice the pattern has drifted:

- Use cases and queries live in flat directories alongside orchestrators with no structural distinction. Reading a constructor is the only way to know whether a use case is atomic or composing.
- Simple CRUD operations have dedicated use case classes that wrap a single repository call, inflating the file count without adding value.
- Some controllers inject repositories directly. Others inject use cases. Others inject facades. There is no enforced contract for how the presentation layer reaches the data layer.
- The boundary between "application service" and "use case" is fuzzy. The community NestJS convention treats application services as optional middleware that sometimes sits between use cases and repositories, with no clear rule for when they apply.
- Orchestrator use cases (that compose other use cases) hide in the same directory as atomic use cases, obscuring the dependency graph.
- External integrations (Salesforce, Gong, Granola) are hand-wired as bespoke services. The Gong stack (#1144-#1150) started introducing hexagonal port/adapter patterns, but the rest of the codebase does not follow them.

This fuzziness is the largest source of architectural drift. It is also the largest obstacle to AI-driven development: Claude and the team cannot reliably generate consistent code when the rules have exceptions.

Dealbrain has zero customers and two internal users. A greenfield rebuild is viable.

## Decision

Adopt proper Domain-Driven Design (DDD) with hexagonal ports for external systems as the foundational architectural pattern for Dealbrain v2.

The architecture has four strict layers with enforced unidirectional dependencies:

```
Controllers  →  Use Cases  →  Domain Services  →  Repositories
                                                        ↓
                                                 Database

External Systems  ←  Adapters  ←  Ports  ←  Use Cases
```

### Layer Definitions

**Repository** — data access layer for a single aggregate. Extends an entity-family base class (see ADR-005). Owns SQL queries via Drizzle ORM. Methods cover CRUD, lookup, filter, and sort — "the ability to get to the data effectively." Repositories are concrete classes, not interfaces, unless they are part of an adapter pattern for an external system.

**Domain Service** — DDD aggregate encapsulating business logic and convenience methods for a single domain (`OpportunityService`, `AccountService`, `ContactService`). Composes the repository with domain expertise. Methods like `opportunity.advanceStage()`, `opportunity.assignPrimaryContact()`. Owns canonical field semantics. May read from any repository in the project. May NOT write outside its own domain (see ADR-004).

**Use Case** — business workflow that composes services and can produce side effects: emit events, enqueue jobs, call external systems, invoke LLMs, orchestrate multiple domains. Named semantically (`NewOpportunity`, `MoveToNextStage`, `AssignPrimaryContact`) rather than CRUD-style (`CreateOpportunity`). Every public operation a consumer can invoke is a use case or a direct service read.

**Controller** — thin protocol adapter (REST, tRPC, MCP, CLI). Translates external protocol concerns (HTTP request/response, RPC envelopes) into use case calls. Contains no business logic.
^Lets debate this. I don't think i fully gree.

### Hexagonal Ports for External Systems

External systems (CRM providers, LLM providers, embedding services, file storage, meeting transcription, email) are abstracted behind **ports** (interfaces) with **adapters** (implementations) per provider. A **provider registry** dispatches adapter selection by key.

Use cases invoke ports, never adapters directly. This applies to both outbound (services we call) and inbound (webhooks we receive) integrations.

The Gong stack pattern (`ITranscriptPort`, `GongTranscriptAdapter`, `ProviderRegistry`, `BaseProviderClient`, `SyncRunRecorder`) becomes the generic infrastructure for all external integrations. The `Integrations` subsystem owns this machinery (see ADR-008).

### Strict Rules

1. **No layer-skipping on writes.** Controllers call use cases. Use cases call services. Services call repositories. The chain is non-negotiable for write operations.
2. **Reads may shortcut.** Controllers may call service read methods directly (`findById`, `list`, `get*`) for pure reads with no side effects (see ADR-003 for the full rule).
3. **No optional layers.** There is no "sometimes the use case calls an application service." Every layer is mandatory when present in the chain. Every domain has a service. Every service extends an entity-family base class.
4. **Hexagonal for externals.** All external system access goes through a port/adapter pair, registered in the Integrations subsystem.
5. **Codegen-enforced.** The architecture is generated from YAML entity definitions. Hand-writing domain code outside the generator's expected structure is a lint violation.

### What This Replaces

- Clean Architecture as practiced in NestJS (use cases as optional CRUD wrappers, application services as optional middleware)
- Bespoke per-provider integration services
- Facades at `presentation/facades/` (the six facades we built in April are the correct concept but lived at the wrong layer — they become the `*.service.ts` layer in the new architecture)
- Flat `use-cases/` directories with no orchestrator distinction

## Consequences

### Positive

- **Zero ambiguity in layer rules.** Every operation has exactly one place to live. AI and humans can generate consistent code because the rules have no exceptions.
- **Domain services become the DDD aggregate.** Opportunity business logic lives on `OpportunityService`. Sales expertise (stage transitions, MEDDPICC evaluation, ownership rules) has one home.
- **Entity-family base classes eliminate ~80% of simple CRUD use cases.** `GetOpportunityByIdUseCase` does not exist — callers use `opportunityService.findById()` which is inherited. Use cases exist only for real business workflows.
- **Hexagonal pattern makes adding a new CRM provider mechanical.** Implement `CRMSyncPort`, register in the provider registry, done. No changes to domain services, no changes to use cases.
- **Codegen can emit the full architecture from YAML.** Every domain module is generated from a schema definition. The team optimizes ~15-20 base modules; the codegen reproduces them everywhere.
- **Testing becomes straightforward.** Services are tested with a real database. Use cases are tested with real services. Adapters are contract-tested against port specifications.
- **AI agents and MCP consume the same use cases as controllers.** One contract, multiple consumers.

### Negative

- **Greenfield rebuild is required.** The existing codebase cannot be incrementally migrated to this shape without continuous churn. We accept the rebuild cost because we have zero customers and two users.
- **Codegen-patterns must evolve significantly.** Track A of the v2 initiative is roughly 3x the current scope of codegen-patterns.
- **Team retraining.** The vocabulary shift from "Clean use cases" to "DDD services + workflows" will take a few working sessions to land.
- **No more optional middleware.** Teams that liked application services as a flexibility point lose that flexibility. In exchange they gain consistency.
- **Hand-written use case inventory must be maintained.** Each real business workflow is a file. This is intentional — it makes the business logic legible — but it is visible work.

### Neutral

- The layer naming (repository, service, use case, controller) stays NestJS-idiomatic. We do not rename to Pattern Stack terms (feature, molecule, organism). The semantics are DDD; the names are NestJS.
- The controller layer stays thin protocol adapters. This is already the direction.
- Integration tests remain the primary test vehicle. Unit tests are reserved for pure logic.

## Alternatives Considered

### Alternative 1 — Keep Clean Architecture, enforce the existing pattern strictly

Add ESLint rules, directory conventions, and review discipline to enforce the current layer pattern. No rebuild.

**Rejected because:**
- The current pattern has ambiguity built into it. Enforcement cannot fix fuzzy rules — it can only enforce them consistently badly.
- The current codebase has drift in both directions (controllers injecting repos, orchestrator use cases hiding in flat directories) that requires per-file judgment to untangle.
- AI-driven code generation produces inconsistent results when layer rules have exceptions.

### Alternative 2 — Pure Vertical Slice Architecture

Each feature/endpoint gets its own folder with all code (controller, handler, validation, data access) collocated. No service layer at all.

**Rejected because:**
- We would lose the DDD aggregate benefit (one place for domain logic per entity).
- Cross-cutting business logic would duplicate across slices.
- The semantic layer and canonical schemas need a central place to live per domain, not per endpoint.

### Alternative 3 — Adopt Pattern Stack directly (Python or TypeScript port)

Port the entire Pattern Stack atomic architecture (atoms/features/molecules/organisms) and its naming conventions to Dealbrain.

**Rejected because:**
- The vocabulary shift is high-friction for a team familiar with NestJS.
- The semantics of the two models are equivalent. Names are the only difference.
- We can get the architectural benefits without the naming disruption.

### Alternative 4 — Hand-write everything, no codegen

Build the architecture manually without evolving codegen-patterns.

**Rejected because:**
- Manual consistency across 10-15 domain modules is a losing battle.
- The whole point of a clean architecture is that its enforcement should be mechanical, not cultural.
- Codegen-first means the architecture is the code that generates it.

## References

- [ADR-002 — Domain-first module layout](./ADR-002-domain-first-module-layout.md)
- [ADR-003 — Service vs use case boundary rules](./ADR-003-service-vs-use-case-boundary.md)
- [ADR-004 — Cross-domain access rules](./ADR-004-cross-domain-access-rules.md)
- [ADR-005 — Entity-family base class inheritance tree](./ADR-005-entity-family-base-classes.md)
- [v2 Initiative Overview](../v2-initiative-overview.md)
- [Gong stack PRs #1144-#1150](the Dealbrain repo) — original hexagonal port/adapter implementation
- [codegen-patterns CODEGEN-EVOLUTION-PLAN.md](../CODEGEN-EVOLUTION-PLAN.md)
