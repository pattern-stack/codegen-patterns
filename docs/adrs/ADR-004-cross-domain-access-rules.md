# ADR-004 — Cross-Domain Access Rules

**Status:** Draft
**Date:** 2026-04-11
**Owner:** Doug
**Related:** ADR-001, ADR-003, ADR-005

## Context

ADR-003 establishes the service vs use case boundary but does not answer: when is a service allowed to reach across domains?

Two real examples motivate the question:

1. `OpportunityService.getOverview()` needs to include the account name and the primary contact's email in its output DTO. Both come from other domains. Should the service query `AccountRepository` and `ContactRepository` directly? Or should this go through a use case that composes `OpportunityService + AccountService + ContactService`?

2. `OpportunityService.transferOwnership()` should update the opportunity's `ownerId` AND mark the new owner as the primary contact's `assigned_rep_id` AND emit an event. The second update is cross-domain.

Example 1 is pragmatic: forcing simple cross-domain joins through use cases would double the file count and make every DTO assembly a workflow. Example 2 is architectural: cross-domain writes couple domains at the write path, which is exactly where we want strong boundaries.

We need a rule that gives pragmatism for reads while enforcing discipline for writes.

## Decision

### The Rule

**Services MAY import any repository in the project for READS. Services MUST NOT WRITE to any repository outside their own domain. Cross-domain writes MUST happen via a use case composing multiple services.**

### Reads — Cross-Domain Allowed

A service may freely import and query any repository, regardless of domain, for purposes of its own operations. This means:

- `OpportunityService` may call `accountRepository.findById()` to get an account name for its output DTO
- `OpportunityService` may call `contactRepository.findByOpportunityId()` to build a comprehensive overview
- `ActivityService` may call `opportunityRepository.findById()` to validate an opportunity reference

Reads do not erode domain boundaries because reads have no consequences. The coupling is shallow — it is a dependency on the data shape, not on the behavior. If the `Account` entity changes shape, `OpportunityService` breaks in exactly the same way a DTO breaks when its source data changes. That is a natural, healthy coupling.

### Writes — Own Domain Only

A service may only write to repositories within its own domain. Writes are where behavior, invariants, side effects, and ownership boundaries live. Allowing `OpportunityService` to write to `ContactRepository` would mean: any change to how contacts handle writes (validation, events, invariants) could be bypassed by opportunity code. That is the coupling we want to avoid.

### Cross-Domain Writes — Compose via Use Case

When a workflow needs to write to multiple domains, it lives in a use case that composes the relevant services:

```ts
class TransferOwnershipUseCase {
  constructor(
    private readonly opportunities: OpportunityService,
    private readonly contacts: ContactService,
    private readonly events: EventBus,
  ) {}

  async execute({ opportunityId, newOwnerId }: TransferOwnershipInput) {
    // opportunityService writes within its own domain
    const opportunity = await this.opportunities.updateOwner(opportunityId, newOwnerId);

    // contactService writes within its own domain
    const primaryContact = await this.contacts.reassignRep(opportunity.primaryContactId, newOwnerId);

    // use case owns the cross-cutting side effect
    await this.events.emit('opportunity.ownership_transferred', {
      opportunityId,
      oldOwnerId: opportunity.previousOwnerId,
      newOwnerId,
      primaryContactId: primaryContact.id,
    });

    return opportunity;
  }
}
```

Each service writes only to its own domain. The use case composes them. Side effects (event emission) live in the use case, per ADR-003.

### Junction Tables — Ownership by Semantic Closeness

Junction tables (e.g., `opportunity_contact`, `opportunity_meeting`) belong to whichever domain is semantically primary. `opportunity_contact` belongs to the Opportunity domain because opportunities own the relationship semantically — you manage contacts from the opportunity view, not opportunities from the contact view.

This means:

- `OpportunityRepository` owns `opportunity_contact` reads and writes
- `ContactRepository` may read `opportunity_contact` (cross-domain read, allowed)
- `ContactService` may NOT write `opportunity_contact` (cross-domain write, forbidden)
- A use case like `AssignPrimaryContact` (which adds a contact to an opportunity and updates the contact's status) lives at the use case layer and composes `OpportunityService + ContactService`

Ownership of a junction table is declared in the entity YAML to avoid ambiguity.

### Cross-Domain Queries That Need Aggregation

Some operations need aggregation across domains — "the 10 accounts with the highest cumulative opportunity amount." This is an **analytics query**, not a CRUD query. It has three possible homes:

1. **A method on `AccountService` that queries `opportunityRepository`** — pragmatic, but starts bloating the service with analytics concerns
2. **A method on `OpportunityService.analytics` via the `BaseAnalyticsService` mixin** — natural if the measure is defined on opportunities
3. **A use case composing multiple services** — for very complex cross-domain rollups

The default is **option 2**: the `BaseAnalyticsService` mixin provides composable measures (sum, count, min, max, avg) that can be grouped by any dimension including dimensions on related entities. `opportunityService.measures.amount.byAccount().sum()` returns the aggregate. The measure definition lives with the opportunity (where the amount field lives), and the grouping traverses the foreign key.

If an analytics query gets too complex for the mixin, it can be hand-written in the service, or if it spans three or more domains, extracted to a use case.

### ESLint Enforcement

The rules are enforceable via import restrictions scoped by file location. The conceptual ESLint configuration:

```yaml
# Services may import repositories anywhere, but only call WRITE methods on own-domain repos
- paths: ['modules/**/*.service.ts']
  allowed_imports:
    - 'modules/*/[!*.service].repository'
  restricted_patterns:
    # Custom rule: writes to foreign repositories (enforced by a custom ESLint rule walking method calls)
    - 'foreign-repo-writes'

# Use cases may import any service
- paths: ['modules/**/use-cases/*.use-case.ts']
  allowed_imports:
    - 'modules/**/*.service'
    - 'modules/subsystems/**'
```

A custom ESLint rule walks method calls on injected repositories and flags any write method (`create`, `update`, `delete`, `upsert*`, etc.) called on a repository that belongs to a different domain than the enclosing service file.

The rule is enforced by filename: `modules/opportunities/opportunity.service.ts` may only call write methods on `opportunity.repository` and any repository whose file lives under `modules/opportunities/` (e.g., `opportunity-contact-link.repository.ts`).

## Consequences

### Positive

- **Pragmatic reads.** The common case (service joins cross-domain data into an output DTO) is simple and direct. No ceremony.
- **Strict writes.** The dangerous case (cross-domain writes) is architecturally forbidden. Coupling happens only at the use case layer where it is visible.
- **ESLint-enforceable.** A custom rule catches violations at lint time. No cultural enforcement needed.
- **Junction table ownership is explicit.** Declaring which domain owns a junction in the entity YAML eliminates ambiguity.
- **Analytics has a clear home.** `BaseAnalyticsService` with composable measures handles most cross-domain aggregations without forcing use cases for simple rollups.

### Negative

- **Reads don't enforce DDD purity.** A strict DDD reading would say every read goes through the owning aggregate's service. Our pragmatism deliberately violates that. We accept the shallower coupling.
- **Custom ESLint rule is maintenance.** We must build and maintain the rule that catches foreign-repo writes. Off-the-shelf `eslint-plugin-boundaries` cannot express this distinction.
- **Analytics complexity can hide.** `BaseAnalyticsService` is powerful, and the team may push complex queries into it rather than extracting them to use cases. Requires judgment about when to escalate.

### Neutral

- Services in the same domain can call each other freely. `OpportunityService` may call helper services within `modules/opportunities/` without constraint.
- Inherited base class methods (from `CrmEntityService`, etc.) do not trigger the rule — they are the service's own implementation, even if the generic base class was defined elsewhere.

## Alternatives Considered

### Alternative 1 — Strict DDD: all cross-domain access through use cases

Services may only touch their own repository. All cross-domain reads go through use cases composing multiple services.

**Rejected because:** DTOs that join across domains (every `getOverview` method) would need a use case wrapper. The file count doubles. Every ergonomic read becomes ceremony. The coupling we're avoiding (behavioral) is not the coupling we're creating (read-shape).

### Alternative 2 — Loose DDD: services may read AND write cross-domain

No restriction. Services call whatever they need.

**Rejected because:** Cross-domain writes are exactly where architectural drift happens. Once `OpportunityService` writes to `ContactRepository`, Contact's invariants can be bypassed. The whole point of domain boundaries erodes.

### Alternative 3 — Separate read service and write service per domain

Split `OpportunityService` into `OpportunityQueryService` and `OpportunityCommandService` (true CQRS). Queries are permissive about cross-domain access; commands are strict.

**Rejected because:** The team already resists CQRS-lite for reads (ADR-003). Full CQRS doubles the service count and adds conceptual overhead for little gain. The single-service model with per-method enforcement is simpler.

### Alternative 4 — Allow cross-domain writes only with explicit "bypass" decorator

Services may write cross-domain if they explicitly annotate a `@CrossDomainWrite('contacts')` decorator on the method.

**Rejected because:** It adds a syntactic escape hatch. Once the escape hatch exists, it gets used. The strict forbid-it-entirely rule is clearer.

## References

- [ADR-001 — DDD + hexagonal architecture](./ADR-001-ddd-hexagonal-architecture.md)
- [ADR-003 — Service vs use case boundary rules](./ADR-003-service-vs-use-case-boundary.md)
- [ADR-005 — Entity-family base class inheritance tree](./ADR-005-entity-family-base-classes.md)
- [ADR-007 — Semantic measure layer](./ADR-007-semantic-measure-layer.md) (pending)
