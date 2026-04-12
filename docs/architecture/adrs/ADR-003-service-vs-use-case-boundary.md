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

### Reads — CQRS-lite Controller Shortcut

For pure reads with no side effects, controllers MAY call service methods directly, skipping the use case layer. The permitted method names are:

- `findById`, `findByIds`, `findAll`
- `list*`, `search*`, `filter*`
- `get*`, `getOverview`, `getBy*`
- Any method defined on the entity-family base class for reads
- Any inherited `BaseAnalyticsService` measure method

Writes and orchestration MUST go through a use case. No exceptions.

This is CQRS-lite: reads can shortcut for ergonomic reasons, writes cannot. The shortcut is ESLint-enforceable by restricting which service method prefixes controllers may import.

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
- **The CQRS-lite read shortcut is an asymmetry.** Writes go through use cases; reads can skip. Some team members may prefer full symmetry. The counter: generating thin `GetByIdUseCase` wrappers for every entity is ceremony that adds no value.
- **Use case depth can grow.** Orchestrator use cases can call other orchestrators. In practice, keep it shallow (2-3 levels) — deeper nesting usually indicates logic that should be a service method instead.

### Neutral

- Services can still call other services within their own domain, but cross-domain service-to-service calls are forbidden at the write path (see ADR-004). This naturally pushes cross-domain orchestration into use cases.
- Services may still expose inherited CRUD from base classes. These are callable from controllers under the read shortcut, which means simple entities have near-zero hand-written code.

## Alternatives Considered

### Alternative 1 — Use cases for everything, including reads

Every operation, including `findById`, goes through a use case. Controllers never call services directly.

**Rejected because:** It creates a uniform contract at the cost of generating hundreds of trivial use case files. AI would spend tokens wrapping `repo.findById()` in a class for no benefit. The CQRS-lite compromise preserves the uniform contract for writes (where coupling matters) and allows reads to shortcut (where ceremony hurts).

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
