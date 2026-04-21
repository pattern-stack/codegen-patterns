# ADR-005 — Entity-Family Base Class Inheritance Tree

**Status:** Superseded by ADR-031 (App-Defined Patterns), 2026-04-19
**Date:** 2026-04-11
**Owner:** Doug
**Related:** ADR-001, ADR-003, ADR-004, ADR-031 (supersedes)

> **Supersedure note (2026-04-19):** Entity families as a closed library-shipped enum (`family: synced | activity | knowledge | metadata`) are replaced by app-defined Patterns. The four family base classes themselves (`SyncedEntityRepository`, etc.) remain as runtime artifacts — they are now referenced by the library-shipped `SyncedPattern`, `ActivityPattern`, `KnowledgePattern`, `MetadataPattern` records rather than by a hard-coded enum. The `family:` YAML key is deleted; entities use `pattern:` instead. The historical context, motivation, and family taxonomy below remain accurate as the design rationale that informed Patterns. See ADR-031 for the current consumer-facing surface.

## Context

Dealbrain has roughly a dozen entity types that cluster into four distinct families based on their access patterns, sync model, and lifecycle:

We have Documents and Notes coming - need to deide where these live.

| Family | Entities | Shared Patterns |
|---|---|---|
| **CRM Synced** | Opportunity, Account, Contact | Bidirectional CRM sync, external ID tracking, full CRUD, visibility filtering, user scoping |
| **Activities** | Meeting, Email, Transcript | Upsert-only (idempotent by external event ID), time-ordered queries, date range filters, opportunity association |
| **Knowledge** | Artifact, Fact, FactEntity | Processing pipeline status (pending/processing/completed/failed), semantic search via pgvector, batch status updates, soft delete with expiry |
| **Metadata** | FieldDefinition, FieldValue | EAV pattern, entity-polymorphic queries (`entityType + entityId`), history tracking, per-user configuration |

Today these patterns are duplicated across every repository and service. Every CRM entity repository has its own `findByExternalId`, `findAllByUserId`, `upsert`, `syncFromProvider` implementation. Every activity entity has its own `findByDateRange`, `findByOpportunityId`, `findRecentByOpportunityId`. The duplication is mechanical — the methods are structurally identical with different types — but it is present.

At the service layer the duplication compounds. Every service has to expose the same inherited CRUD methods. Every service has to implement its own version of "find visible to user." Adding a new CRM entity requires copying the template.

If we are rebuilding anyway, we should extract the duplication into an entity-family base class inheritance tree and let domain-specific code add only what is genuinely domain-specific.

## Decision

Establish four entity-family base classes at the repository layer and four parallel base classes at the service layer. Concrete repositories and services extend the appropriate family base. The base classes provide the shared patterns as inherited methods; concrete classes add entity-specific behavior only.

### Repository Base Class Tree

```
BaseRepository<TEntity>
  │
  ├── findById(id): Promise<TEntity | null>
  ├── findByIds(ids): Promise<TEntity[]>
  ├── list(filters?): Promise<TEntity[]>
  ├── count(filters?): Promise<number>
  ├── exists(id): Promise<boolean>
  ├── create(input): Promise<TEntity>
  ├── update(id, input): Promise<TEntity>
  ├── delete(id): Promise<void>
  └── upsertMany(inputs): Promise<TEntity[]>

  ┌──────────┴──────────┬──────────────────────┬───────────────────┐
  │                     │                      │                   │

CrmEntityRepository    ActivityEntityRepository    KnowledgeEntityRepository    MetadataEntityRepository
  │                     │                      │                   │
  ├── findByExternalId   ├── findByDateRange     ├── findByOpportunityId      ├── upsertMany (EAV-shaped)
  ├── findManyByExternalIds ├── findByUserId      ├── semanticSearch            ├── findByEntityIdAndType
  ├── findAllByUserId    ├── findByOpportunityId  ├── findPendingByOpportunityId ├── listByEntityId
  ├── findVisibleByUserId ├── findRecentByOpportunityId ├── claimPendingByOpportunityId ├── listByEntityIds (batch)
  ├── updateVisibility   ├── findUpcomingByOpportunityId ├── updateStatus             ├── listHistoryByEntityId
  └── syncUpsert          │                      ├── updateStatusBatch          └── findHistoryEntryById
                          │                      ├── softDelete (with expiry)
                          │                      └── setBatchId
```

### Declarative Query Generation — `queries:` Block

Many retrieval methods follow common patterns — "find by FK", "find by FK + type", "find by FK + date range." Rather than hand-coding each method, entities declare their query patterns in the YAML, and the codegen generates the corresponding repository and service methods.

```yaml
# entities/contact.yaml
queries:
  - by: [opportunity_id]                    # → findByOpportunityId(opportunityId)
  - by: [user_id]                           # → findByUserId(userId)
  - by: [email]                             # → findByEmail(email)
    unique: true                            # Returns single result, not array
  - by: [user_id, account_id]              # → findByUserIdAndAccountId(userId, accountId)
  - by: [opportunity_id]
    select: [email]                         # → findEmailsByOpportunityId(opportunityId)
  - by: [account_id]
    order: created_at desc                  # → findByAccountId(accountId) with default ordering
    limit: true                             # Generates paginated variant too
```

**What each query declaration generates:**

1. **Repository method** — Drizzle query with `eq()` / `and()` / `inArray()` filters matching the `by` fields. Handles `unique` (returns `T | null` vs `T[]`), `select` (projection), `order` (default sort), `limit` (pagination).
2. **Service method** — Pass-through that delegates to repository, with the same signature.
3. **Read use case** — Auto-generated use case wrapping the service method (per the "no exceptions" rule from ADR-003).

**Naming convention:** Method names are derived mechanically from the `by` fields:
- `by: [opportunity_id]` → `findByOpportunityId`
- `by: [user_id, date_range]` → `findByUserIdAndDateRange`
- `by: [opportunity_id]` + `select: [email]` → `findEmailsByOpportunityId`

**Family-level defaults:** Each entity family pre-declares common queries. CRM entities get `findByUserId`, `findByExternalId`. Activities get `findByOpportunityId`, `findByDateRange`. These are inherited; the entity YAML only declares entity-specific additions.

**Junction table queries:** For entities with junction relationships, the `by` field can reference across the junction:
```yaml
queries:
  - by: [opportunity_id]
    via: opportunity_contact_link          # Generates JOIN through junction table
```

This system makes the base class inheritance tree composable with entity-specific queries, all from declarative YAML. The codegen generates the full chain: repository → service → use case.

Concrete repositories (`OpportunityRepository`, `AccountRepository`, etc.) extend the appropriate family base and add methods that are unique to that entity. For example:

```ts
class OpportunityRepository extends CrmEntityRepository<Opportunity> {
  // Inherited: findById, findByExternalId, findAllByUserId, findVisibleByUserId,
  //            syncUpsert, create, update, delete, upsertMany, etc.

  // Entity-specific additions:
  async findSingleOpportunityAccountIds(userId: string): Promise<Map<string, string>> { ... }
  async appendEmailDomain(id: string, userId: string, domain: string): Promise<Opportunity> { ... }
  async removeEmailDomain(id: string, userId: string, domain: string): Promise<Opportunity> { ... }
}

class ContactRepository extends CrmEntityRepository<Contact> {
  // Inherited: standard CRM CRUD

  // Entity-specific additions:
  async findManyByEmails(emails: string[], userId: string): Promise<Contact[]> { ... }
  async findEmailsByOpportunityId(opportunityId: string): Promise<string[]> { ... }
  async findOpportunityIdsByEmailsGrouped(...): Promise<Map<string, string[]>> { ... }
}
```

### Service Base Class Tree

```
BaseService<TRepo, TEntity>
  │
  ├── findById(id): Promise<TEntity>
  ├── findByIds(ids): Promise<TEntity[]>
  ├── list(filters?): Promise<TEntity[]>
  ├── count(filters?): Promise<number>
  ├── exists(id): Promise<boolean>
  ├── create(dto): Promise<TEntity>           ← thin pass-through, no side effects
  ├── update(id, dto): Promise<TEntity>       ← thin pass-through, no side effects
  ├── delete(id): Promise<void>               ← thin pass-through, no side effects
  └── Transactional helpers

  ┌──────────┴──────────┬──────────────────────┬───────────────────┐
  │                     │                      │                   │

CrmEntityService       ActivityEntityService    KnowledgeEntityService    MetadataEntityService
  │                     │                      │                   │
  ├── findByExternalId   ├── findByDateRange     ├── findByOpportunity         ├── listByEntity
  ├── findAllByUser      ├── findByUser          ├── semanticSearch            ├── listHistory
  ├── findVisibleByUser  ├── findByOpportunity   ├── listPendingForOpportunity ├── upsertValues
  ├── getFieldValues     ├── findRecent          └── (pipeline helpers)         └── (EAV helpers)
  ├── getFieldHistory    └── findUpcoming
  └── (canonical field access)

BaseAnalyticsService (mixin applied to every concrete service)
  │
  ├── measures.<name>.sum()
  ├── measures.<name>.count()
  ├── measures.<name>.avg()
  ├── measures.<name>.min()
  ├── measures.<name>.max()
  └── measures.<name>.by(dimension).filter(...).aggregate(...)
```

Concrete services extend the appropriate family base AND pick up the `BaseAnalyticsService` mixin for composable measures. The mixin is applied via TypeScript generic composition:

```ts
class OpportunityService extends WithAnalytics(CrmEntityService<OpportunityRepository, Opportunity>) {
  // Inherited: findById, findAllByUser, findVisibleByUser, getFieldValues, etc.
  // Inherited: measures.amount.by('owner').sum(), etc.

  // Entity-specific domain logic:
  async advanceStage(id: string): Promise<Opportunity> { ... }
  async closeWon(id: string, reason: string): Promise<Opportunity> { ... }
  async closeLost(id: string, reason: string): Promise<Opportunity> { ... }
  async assignPrimaryContact(id: string, contactId: string): Promise<Opportunity> { ... }
  async getOverview(id: string): Promise<OpportunityOverview> { ... }
}
```

### Family Boundaries — Rules

Each entity belongs to **exactly one family**. The family is declared in the entity YAML definition:

```yaml
entity:
  name: opportunity
  family: crm-synced    # crm-synced | activity | knowledge | metadata
```

Once assigned, the entity extends the family base classes and inherits their methods. Codegen enforces this — you cannot declare an entity without a family, and the family determines which templates generate.

### Why Four Families (Not Three or Five)

Each family has distinctly different access patterns that cannot be collapsed:

- **CRM synced** entities are bidirectional with external systems. They need external ID tracking, sync state, and visibility rules.
- **Activities** are ingested from integrations and are time-ordered events. They are upsert-only (no delete), and queries are dominated by time and association.
- **Knowledge** entities are extracted from source content through a processing pipeline. They need status state machines, batch operations, semantic search, and soft delete with expiry.
- **Metadata** entities use the EAV pattern. Their queries are polymorphic by `entityType + entityId`, which doesn't fit any of the other families.

A fifth family for, e.g., "join tables" or "audit logs" might emerge. When it does, the YAML gets a new `family` enum value and codegen gets new templates. This is an open-ended extension point.
**Note:** A fifth family for associations/junction tables is expected. Implementation approach (ORM-managed vs explicit Pattern Stack-style) to be decided based on Pattern Stack backend-patterns validation. The `queries:` block with `via:` already supports junction traversal at the query level; the open question is whether junction tables get their own entity family or remain as plain `BaseRepository` extensions.

### Open Question — Knowledge Family

The Knowledge family may be unnecessary. Artifacts and facts are always derived from activities, and their access patterns (find by opportunity, pipeline status) might fit the Activity family with minor additions. A decision is needed before Track A begins.

Current position: keep Knowledge separate because the semantic search and pipeline status patterns are fundamentally different from time-ordered activities. Revisit if the distinction proves fictional during implementation.

## Consequences

### Positive

- **80% reduction in hand-written repository and service code.** Inherited methods cover the common cases. Concrete classes only add what is truly domain-specific.
- **Uniform shape for AI generation.** An AI (or a human) can generate a new entity by picking a family and declaring entity-specific methods. The rest is mechanical.
- **Codegen simplification.** Templates for each family are distinct but internally consistent. Adding a new CRM entity is one YAML file.
- **Testability improves.** Base classes are tested once with a reference entity. Concrete classes only need tests for the methods they add.
- **Simple CRUD use cases vanish.** `GetOpportunityByIdUseCase` does not exist. The controller calls `opportunityService.findById()` (inherited from `BaseService`). ADR-003's CQRS-lite shortcut applies.
- **Canonical field access is centralized.** `CrmEntityService` exposes `getFieldValues()` and `getFieldHistory()` with the same signature for every CRM entity. Canonical field semantics are defined once.

### Negative

- **TypeScript generic complexity.** `CrmEntityService<TRepo extends CrmEntityRepository<TEntity>, TEntity>` with mixin composition (`WithAnalytics`) is non-trivial TS. The team needs to grok the pattern, and error messages can be verbose.
- **Inheritance is less flexible than composition.** If an entity needs 80% of CRM family behavior but also something unique to another family, inheritance is awkward. Composition (mixins) is the escape hatch, but it adds complexity.
- **Family misassignment is painful.** Declaring an entity as `crm-synced` and later realizing it should be `activity` means rewriting the concrete class. This happens rarely but is a refactor, not a rename.
- **Knowledge family may be gratuitous.** If it turns out Activity + entity-specific methods covers it, Knowledge is dead weight. Open question above.
- **The base class hierarchy is a maintenance artifact.** When the CRM sync pattern changes, the base class changes, and every derived class potentially breaks. This is the standard inheritance tradeoff.

### Neutral

- Junction table repositories (`opportunity-contact`, `opportunity-meeting`) extend `BaseRepository` directly. They are not in any family — they are link tables with their own shapes.
- The User entity does not belong to any family. It is its own special case with auth integration. `UserRepository extends BaseRepository<User>` directly.
- `BaseAnalyticsService` is a mixin applied to all concrete services in all families. Measures are declared in the entity YAML regardless of family.

## Alternatives Considered

### Alternative 1 — One `BaseService<T>` and no family distinction

All entities extend a single base class. Concrete services add their own version of `findByExternalId`, `findByDateRange`, etc.

**Rejected because:** The duplication comes right back. Every CRM entity reimplements CRM sync patterns; every activity entity reimplements time queries. The whole point of the family tree is to prevent this.

### Alternative 2 — Composition only, no inheritance

Use TypeScript mixins for everything. Concrete services compose `WithCrmSync + WithCanonicalFields + WithAnalytics`.

**Rejected because:** Mixins in TS are powerful but produce worse IDE autocomplete, harder type errors, and more verbose declarations than inheritance. Inheritance is fine for the entity family case because the families are mutually exclusive (an entity is either CRM-synced or an activity, not both).

### Alternative 3 — Generate all repository/service code without base classes

The codegen emits the full method bodies for every entity. No inheritance at all.

**Rejected because:** Every change to a shared pattern requires regenerating every entity. Base classes let us fix a bug in CRM sync once and have it propagate. They also make the code shorter and easier to read.

### Alternative 4 — Interfaces only, no shared implementation

Define `ICrmEntityRepository<T>` as an interface. Each concrete repository implements it independently.

**Rejected because:** Shared implementation is the whole point. Interfaces give you a contract but force every implementation to reinvent. The codegen could emit templated implementations, but inheritance is strictly simpler.

## References

- [ADR-001 — DDD + hexagonal architecture](./ADR-001-ddd-hexagonal-architecture.md)
- [ADR-003 — Service vs use case boundary rules](./ADR-003-service-vs-use-case-boundary.md)
- [ADR-004 — Cross-domain access rules](./ADR-004-cross-domain-access-rules.md)
- [ADR-006 — Canonical CRM schema as foundational layer](./ADR-006-canonical-crm-schema.md) (pending)
- [ADR-007 — Semantic measure layer](./ADR-007-semantic-measure-layer.md) (pending)
- [Pattern Stack — BaseService documentation](https://agentic-patterns.pattern-stack.com)
