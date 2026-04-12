# ADR-003 — Service vs Use Case Boundary Rules

**Status:** Draft
**Date:** 2026-04-11
**Owner:** Doug
**Related:** ADR-001, ADR-004, ADR-005

## Context

The single largest source of architectural ambiguity in the current Dealbrain codebase is the fuzzy line between "use case" and "service." The NestJS community convention treats application services as an optional middle layer that a use case may or may not delegate to. The current codebase has:

- Simple CRUD use cases that are thin wrappers around a single repository call
- Orchestrator use cases that compose other use cases
- Application services used inconsistently — sometimes for shared logic, sometimes bypassed
- Controllers that inject repositories directly, skipping all middleware
- Queries that compose multiple repositories (doing application-service work inside a query class)

The result: no two consumers of the same data operation go through the same layers. AI and humans cannot generate consistent code because the rules have exceptions.

We need an absolute, mechanical rule that determines where a given piece of logic lives — one that can be enforced by ESLint, used by codegen, and applied by AI without judgment calls.

## Decision

### The Sharp Test

**If an operation can produce a side effect outside the database, it belongs in a use case. Otherwise it belongs in a service method.**

That is the only rule. Every operation is classified by this test.

### Services — What Belongs

Services contain **pure data operations** for a single domain aggregate. They may:

- Query the database (one or more repositories, including cross-domain reads — see ADR-004)
- Transform data between shapes (entity → DTO, canonical field mapping)
- Compose domain logic (stage transition rules, canonical field validation, semantic measure calculations)
- Inherit standard CRUD from their entity-family base class (see ADR-005)
- Call other services in their own domain
- Expose convenience methods that group related reads (e.g., `opportunityService.getOverview()` which joins account and contacts)

Services may NOT:

- Emit domain events
- Enqueue background jobs
- Call external systems (CRM, LLM, embedding, file storage)
- Invoke agents
- Perform permission/ownership checks beyond user scoping
- Write to repositories outside their own domain (see ADR-004)
- Throw authorization errors (those belong at the use case or controller layer)

### Use Cases — What Belongs

Use cases contain **business workflows that produce side effects** or orchestrate across multiple concerns. They may:

- Compose multiple services (including across domains)
- Emit domain events
- Enqueue background jobs
- Call external systems via ports
- Invoke the LLM subsystem
- Invoke the agents subsystem (Track C)
- Perform permission and ownership checks
- Execute transactional workflows
- Call other use cases (see composition rules below)

Use cases should NOT:

- Contain SQL or ORM code directly
- Bypass services to reach repositories
- Duplicate domain logic that belongs in a service

### Naming Convention — Semantic, Not CRUD

Use case names represent business operations, not CRUD primitives.

- Prefer `NewOpportunity` over `CreateOpportunity`
- Prefer `MoveToNextStage` over `UpdateStageUseCase`
- Prefer `AssignPrimaryContact` over `SetPrimaryContactUseCase`
- Prefer `CloseWon` / `CloseLost` over `UpdateOpportunityStatusUseCase`
- Prefer `ChangeOwnership` over `TransferOwnerUseCase`

The name should read like a thing a salesperson would say.

### Reads — Auto-Generated Read Use Cases (No Exceptions)

Controllers ALWAYS call use cases. There is no shortcut for reads. The rule is absolute: **controllers → use cases → services → repositories**. No layer-skipping, no asymmetry, no exceptions.

To avoid ceremony bloat, **standard read use cases are auto-generated from the entity-family base class.** The codegen emits inherited read use cases that delegate to the corresponding service method:

- `FindByIdUseCase` → `service.findById()`
- `ListUseCase` → `service.list()`
- `SearchUseCase` → `service.search()` (when applicable)
- Any read method defined on the entity-family base class

These are thin pass-throughs — but they exist as first-class use cases, not as exceptions to the rule. This means:

1. **Controllers have one dependency type: use cases.** No conditional "use cases for writes, services for reads" logic.
2. **The use case directory is the complete API surface.** Every operation the app exposes is visible in `use-cases/`.
3. **ESLint enforcement is trivial.** Controllers may only import `*.use-case.ts`. Period.
4. **If a read later needs side effects** (audit logging, analytics tracking), promote the auto-generated use case to a hand-written one. No controller change needed.

The auto-generated read use cases are inherited from a base class, so adding them costs zero hand-written code per entity. The tradeoff is a few more files — but those files make the architecture legible and the rules exceptionless.

### Use Cases Composing Use Cases — The Rule

A use case MAY call another use case, but only if the called use case is **independently meaningful to consumers**. That means the called use case is also exposed at some presentation layer (REST, tRPC, MCP, agent tool) — not just as a private helper.

If logic is reusable ONLY by other use cases and is never called independently, it is **not** a use case. It is a **service method** (private domain logic) or a **shared helper** under `shared/`.

This follows Thiago's stated rule in the April Slack thread — and he is right:

> "We should only compose use cases when a given use case can be accessed in two different ways: (1) directly accessed from something in the presentation layer, (2) used by another use case. If the only reason why a use case exists is because two other use cases are using it, then it shouldn't be a use case — it should be an application service."

In the v2 architecture, "application service" becomes **service method** (since domain services are the DDD aggregate layer).

### The Self-Documenting Tell

Under these rules, the constructor of a use case tells the whole story:

- **Injects services only** → atomic use case
- **Injects other use cases** → orchestrator composing real business operations

No naming convention or directory split is needed. A glance at the constructor reveals the type.

### What About Simple CRUD Use Cases?

Under this rule, `CreateOpportunityUseCase` as a thin wrapper around `repository.create()` does not exist. If creating an opportunity has no side effects — no event emission, no CRM sync, no validation beyond the DTO — then the controller calls `opportunityService.create()` directly. The inherited base class method handles it.

In practice, creating an opportunity almost always has side effects: CRM sync, event emission, stakeholder notification. In those cases a hand-written `NewOpportunity` use case exists and encodes the workflow.

The result: **use cases only exist when they are doing real work.** Every file in `use-cases/` represents a meaningful business operation. Reading the directory listing is reading a list of things the business does.

## Consequences

### Positive

- **Zero ambiguity.** Every piece of logic has exactly one rule that determines where it goes. AI and humans apply the rule identically.
- **ESLint-enforceable.** The sharp test maps to enforceable imports: services may not import the events subsystem, jobs subsystem, LLM subsystem, agents subsystem, or any integration port. Use cases may.
- **Eliminates simple use case bloat.** The current codebase has many use cases whose entire implementation is `return this.repo.find(...)`. Those disappear.
- **Use case directory becomes business documentation.** Reading `modules/opportunities/use-cases/` tells you exactly what the business does with opportunities.
- **Thiago's position and Doug's position reconcile.** Services = application services (in Thiago's terminology). Workflows = use cases. The disagreement was semantic; the resolution is a consistent naming.
- **Services become trivially testable.** No external system mocks needed — services only touch the database.

### Negative

- **Some operations feel over-categorized.** "Assign primary contact" is a single field update — does it need a whole use case file? Under the rule, yes if it emits an event or syncs to CRM (which it probably does). If it doesn't, it's a service method.
- **Requires discipline about what counts as a "side effect."** Audit logging, cache invalidation, and event emission are all side effects. Teams may try to push these into services ("it's just logging"). They cannot.
- **More files per entity.** Auto-generated read use cases add files to the `use-cases/` directory. These are inherited/generated (zero hand-written code), but they are visible in the tree. The tradeoff is worth it: the directory is now a complete API surface with no hidden shortcuts.
- **Use case depth can grow.** Orchestrator use cases can call other orchestrators. In practice, keep it shallow (2-3 levels) — deeper nesting usually indicates logic that should be a service method instead.

### Neutral

- Services can still call other services within their own domain, but cross-domain service-to-service calls are forbidden at the write path (see ADR-004). This naturally pushes cross-domain orchestration into use cases.
- Services expose inherited CRUD from base classes. These are consumed by auto-generated read use cases, which controllers import. Simple entities have near-zero hand-written code — the base class handles both the service methods and the corresponding use case wrappers.

## Alternatives Considered

### Alternative 1 — CQRS-lite: controllers call services directly for reads

Controllers MAY call service read methods directly, skipping the use case layer for pure reads.

**Rejected because:** It introduces an exception to the layer rule. Controllers would need to know which operations are "reads" (call service) vs "writes" (call use case). This asymmetry creates confusion, makes ESLint enforcement conditional, and hides part of the API surface from the use case directory. Auto-generating read use cases from base classes eliminates the ceremony concern without introducing an exception.

### Alternative 2 — Services for everything, no use cases

Eliminate the use case layer entirely. Services contain all logic including side effects.

**Rejected because:** Services become giant classes with mixed responsibilities (data access + event emission + external calls). The testing story degrades (services need external system mocks). And the `modules/opportunities/` directory loses its business documentation property.

### Alternative 3 — Three layers: services, orchestrators, workflows

Distinguish atomic orchestrators from full workflows at a file level.

**Rejected because:** It reintroduces the ambiguity we are trying to eliminate. The sharp test gives us two clean buckets. Adding a third bucket invites "is this an orchestrator or a workflow?" judgment calls.

### Alternative 4 — Allow services to emit events

Let services emit domain events but nothing else (no external calls, no jobs).

**Rejected because:** Events are side effects. Allowing them blurs the rule. If a team later decides events are fine, they start wanting jobs, then external calls. The slippery slope is real. Keep the rule absolute.

## References

- [ADR-001 — DDD + hexagonal architecture](./ADR-001-ddd-hexagonal-architecture.md)
- [ADR-004 — Cross-domain access rules](./ADR-004-cross-domain-access-rules.md)
- [ADR-005 — Entity-family base class inheritance tree](./ADR-005-entity-family-base-classes.md)
- April Slack thread with Thiago — captured in [session_2026_04_09_facade_architecture](project memory)
