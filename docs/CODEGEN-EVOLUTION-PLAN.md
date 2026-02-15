# Codegen Evolution Plan

Reference document for evolving the entity codegen system to support integrations, multiple architecture outputs, and simplified configuration.

## Context

The codegen tool generates full-stack Clean Architecture scaffolding from YAML entity definitions. It currently targets the dealbrain project (NestJS + Drizzle + React). This plan extends it to:

1. Support integration-aware entities (bi-directional CRM sync, CDC, Electric SQL)
2. Offer multiple architecture output targets (Clean, Clean-Lite, Vertical Slice)
3. Simplify the configuration surface area
4. Generate event/handler infrastructure alongside entities

## Current State

**What works well:**
- YAML DSL with Zod-validated schema (fields, relationships, behaviors)
- Clean Architecture template generation (domain, application, infrastructure, presentation)
- Configurable naming conventions matching dealbrain's patterns
- Behaviors system (timestamps, soft_delete, user_tracking)
- Domain analyzer (graph, validation, transitive relationship suggestions)
- Frontend generation (Electric collections, hooks, mutations, field metadata)

**What's overgrown:**
- Too many frontend config knobs (typeNaming, collectionNaming, fileNaming, hookReturnStyle, fkResolution, columnMapper, etc.)
- Scanner solves a problem we don't have yet (one project, known conventions)
- Backend/frontend/shared generation mixed into one pipeline with per-toggle flags
- No concept of integrations, sync, events, or provider adapters

---

## Phase 1: Simplify Existing Codegen

### 1.1 Introduce Presets

Collapse the ~12 frontend config knobs into named presets:

```yaml
frontend:
  preset: dealbrain
  # Expands to:
  #   typeNaming: plain
  #   collectionNaming: singular
  #   fileNaming: singular
  #   hookReturnStyle: generic
  #   fkResolution: true
  #   sync:
  #     shapeUrl: '/v1/shape'
  #     useTableParam: true
  #     columnMapper: snakeCamelMapper
  #     columnMapperNeedsCall: true
  #     wrapInUrlConstructor: true
  #     apiBaseUrlImport: '@/lib/config'
  #   parsers:
  #     timestamptz: '(d: string) => new Date(d)'
  #     date: '(d: string) => new Date(d + "T00:00:00")'
```

Individual overrides still work - preset sets defaults, explicit values win.

### 1.2 Separate Pipelines

Replace per-toggle flags with independent pipeline config:

```yaml
pipelines:
  backend:
    enabled: true
    architecture: clean          # clean | clean-lite | vertical-slice
  frontend:
    enabled: true
    preset: dealbrain
  shared:
    enabled: true                # Zod schemas in packages/db
```

Setting `frontend.enabled: false` replaces manually toggling `fieldMetadata: false`, `collections: false`, `hooks: false`, `mutations: false`.

### 1.3 Evaluate Scanner Scope

The scanner (framework-detector, orm-detector, architecture-detector, naming-detector, config-generator) is ~1200 lines solving the problem of "detect an unknown project's conventions." We have one project with known conventions.

Options:
- **Extract** to a standalone tool (`codegen-scanner`) that generates a config file as a one-time setup step
- **Shelve** behind a flag (`bun codegen scan` still works, but not maintained as core)
- **Keep** if we anticipate onboarding new projects soon

Recommendation: Extract. It's useful but doesn't need to ship in the core codegen loop.

---

## Phase 2: Add Integration Concepts to YAML DSL

### 2.1 Entity-Level Sync Declaration

Add optional `sync:` block to entity YAML. Each entity is one YAML file (e.g., `entities/opportunity.yaml`). The top-level keys (`entity:`, `fields:`, `relationships:`, `behaviors:`, `sync:`, `events:`) are peer sections within that file - this matches the existing schema convention:

```yaml
# entities/opportunity.yaml
entity:
  name: opportunity
  plural: opportunities
  table: opportunities

fields:
  name:
    type: string
    required: true
    max_length: 255
  amount:
    type: decimal
    nullable: true
  stage:
    type: string
    nullable: true
    max_length: 100
  close_date:
    type: date
    nullable: true
  probability:
    type: integer
    nullable: true
    min: 0
    max: 100
  is_closed:
    type: boolean
    required: false
    default: false
  is_won:
    type: boolean
    required: false
    default: false

behaviors:
  - timestamps
  - soft_delete
  - external_id_tracking       # NEW: adds externalId, provider, providerMetadata

sync:
  electric: true                # Publish to Electric SQL for frontend real-time sync
  providers:
    salesforce:
      remote_entity: Opportunity
      direction: bidirectional
      cdc: true
      field_mapping:
        # local_field: remote_field
        name: Name
        amount: Amount
        stage: StageName
        close_date: CloseDate
        probability: Probability
        is_closed: IsClosed
        is_won: IsWon
      read_only_fields:
        - is_closed
        - is_won

relationships:
  account:
    type: belongs_to
    target: account
    foreign_key: account_id
  owner:
    type: belongs_to
    target: user
    foreign_key: owner_id
```

### 2.2 New Behavior: `external_id_tracking`

Adds fields that every synced entity needs:

```yaml
# What it generates on the entity:
fields:
  external_id:
    type: string
    nullable: true
    index: true
    max_length: 255
  provider:
    type: string
    nullable: true
    max_length: 50
  provider_metadata:
    type: json
    nullable: true
```

Plus a unique index on `(user_id, external_id)` when both exist.

### 2.3 What `sync:` Generates

When `sync:` is present on an entity, the codegen produces additional outputs:

**Backend:**
- Field mapping config file (replaces hardcoded `field-mappings.ts`)
- Entity sync config (remote entity name, direction, field list)
- CDC event class (if `cdc: true`)
- Inbound CDC event handler stub (if `cdc: true`)
- Outbound change event class (if `direction: outbound | bidirectional`)

**Database:**
- Electric SQL migration: `ALTER TABLE ... REPLICA IDENTITY FULL` + `ALTER PUBLICATION ... ADD TABLE ...` (if `electric: true`)

**Shared:**
- Sync-aware Zod schemas (marks read_only_fields as optional on create DTO)

### 2.4 Event Declarations

Events can be declared inline on entities or as standalone files:

**Inline (declared within an entity YAML file):**

```yaml
# entities/opportunity.yaml - events section lives alongside fields, relationships, etc.
entity:
  name: opportunity
  plural: opportunities
  table: opportunities

fields:
  name:
    type: string
    required: true
    max_length: 255
  # ... other fields

behaviors:
  - timestamps
  - external_id_tracking

sync:
  electric: true
  providers:
    salesforce:
      remote_entity: Opportunity
      direction: bidirectional
      cdc: true
      field_mapping:
        name: Name

# Events declared here are scoped to this entity
events:
  - name: import_opportunities
    queue: import-queue
    body:
      integration_id: uuid
      user_id: uuid
      external_ids: uuid[]
    generate_handler: true
```

**Standalone (for cross-entity events):**

```yaml
# events/inbound-cdc.yaml
event:
  name: inbound_cdc
  queue: inbound-cdc-queue

body:
  integration_id: uuid
  user_id: uuid
  entity_type: string
  external_id: string
  change_type:
    type: enum
    choices: [create, update, delete]
  record_data: json
  transaction_id: string
  cdc_event_id: uuid

generate_handler: true
```

**What event declarations generate:**
- Event class extending `BaseEvent<TBody>` with typed body
- Event handler stub in `presentation/event-handlers/`
- Queue registration in `events.module.ts` (inject template)
- Body DTO with Zod validation

---

## Phase 3: Add Clean-Lite Output Target

### 3.1 Architecture Comparison

**Clean (current, ~12 files per entity):**
```
domain/{entity}/
  {entity}.entity.ts
  {entity}.repository.interface.ts
application/
  use-cases/{entity}/
    create-{entity}.use-case.ts
    update-{entity}.use-case.ts
    delete-{entity}.use-case.ts
  queries/{entity}/
    get-{entity}-by-id.query.ts
    get-all-{entities}.query.ts
  schemas/
    {entity}.dto.ts
infrastructure/
  database/repositories/{entity}.repository.ts
  database/drizzle/{entity}.schema.ts
  modules/{entities}.module.ts
presentation/
  rest/{entities}.controller.ts
```

**Clean-Lite (new, ~6 files per entity):**
```
modules/{entities}/
  {entity}.entity.ts              # Drizzle schema + domain type (merged)
  {entity}.service.ts             # CRUD + business logic (replaces use cases)
  {entity}.repository.ts          # DB access (concrete, no interface unless synced)
  {entity}.controller.ts          # REST endpoints
  {entity}.dto.ts                 # Zod input/output schemas
  {entities}.module.ts            # NestJS wiring
```

**When `sync:` is present, Clean-Lite adds:**
```
modules/{entities}/
  {entity}.repository.interface.ts  # Interface needed for adapter swap
  {entity}.sync-config.ts           # Field mappings + sync configuration
```

**Vertical Slice (future, ~5 files per entity):**
```
modules/{entities}/
  {entity}.schema.ts              # Drizzle schema
  {entity}.service.ts             # All logic
  {entity}.controller.ts          # REST endpoints
  {entity}.dto.ts                 # Zod schemas
  {entities}.module.ts            # NestJS wiring
```

### 3.2 Architecture Selection

```yaml
pipelines:
  backend:
    architecture: clean-lite
```

The YAML input is identical across all three. Only the template set changes.

### 3.3 Offsite Deliverable

Generate the same `opportunity.yaml` through all three targets. Present side-by-side:
- File count comparison
- Code diff for a field change (add a column)
- Where the business logic lives
- How sync entities differ

---

## Phase 4: Provider Adapter Generation

### 4.1 Provider Definitions

Separate from entity YAML. Defines a provider's capabilities:

```yaml
# integrations/salesforce.yaml
provider:
  name: salesforce
  display_name: Salesforce

  capabilities:
    - reader
    - bulk_reader
    - writer
    - describer
    - lister

  auth:
    type: workos                    # WorkOS handles SSO/auth
    # WorkOS manages the OAuth flow and token exchange
    # Provider-specific fields stored on integration record:
    stored_fields:
      - instance_url
      - scopes

  webhook:
    enabled: true
    signature_validation: true
    event_types:
      - entity_created
      - entity_updated
      - entity_deleted

  retry:
    max_attempts: 3
    backoff_multiplier: 2.0
    initial_delay_seconds: 1.0
    max_delay_seconds: 60.0
    retry_on_status_codes: [429, 500, 502, 503, 504]
```

### 4.2 What Provider Definitions Generate

**Domain layer:**
- Adapter interface/abstract class with typed methods per capability
- Provider-specific credential type (extending base integration model)

**Infrastructure layer:**
- Adapter implementation stub (with TODO placeholders per capability method)
- Webhook validation method stub
- Field mapping utility (used by entity sync configs)

**Module layer:**
- DI token registration
- Module with adapter provider

**Example generated adapter stub:**

```typescript
// infrastructure/adapters/salesforce/salesforce.adapter.ts

@Injectable()
export class SalesforceAdapter implements IEntityReader, IBulkEntityReader, IEntityWriter, IEntityDescriber, IEntityLister {
  constructor(
    @Inject(INTEGRATION_REPOSITORY)
    private readonly integrationRepo: IIntegrationRepository,
  ) {}

  async readOne(credentials: ProviderCredentials, entityType: string, externalId: string): Promise<DataResult<Record<string, unknown>>> {
    // TODO: Implement Salesforce single record read
    throw new Error('Not implemented');
  }

  async readMany(credentials: ProviderCredentials, entityType: string, filters: QueryFilter[]): Promise<DataResult<Record<string, unknown>[]>> {
    // TODO: Implement Salesforce bulk read
    throw new Error('Not implemented');
  }

  // ... other capability methods

  validateWebhook(payload: Buffer, signature: string): boolean {
    // TODO: Implement Salesforce webhook signature validation
    return false;
  }
}
```

### 4.3 Provider + Entity Sync Relationship

Provider definitions and entity sync declarations work together:

```
integrations/salesforce.yaml     → Generates adapter infrastructure
entities/opportunity.yaml sync:  → Generates field mappings + sync config
                                    referencing the Salesforce adapter
```

The entity's `sync.providers.salesforce` block must reference a provider defined in `integrations/`.

---

## Implementation Priority

| Phase | Effort | Impact | Dependencies |
|-------|--------|--------|--------------|
| Phase 1 (Simplify) | Small | High - reduces cognitive load, makes tool approachable | None |
| Phase 2 (Integrations in YAML) | Medium | High - models the product's core differentiator | Phase 1 (presets/pipelines) |
| Phase 3 (Clean-Lite output) | Medium | Medium - offsite deliverable, architecture flexibility | Phase 1 (pipeline separation) |
| Phase 4 (Provider generation) | Medium | Medium - reduces adapter boilerplate | Phase 2 (sync declarations) |

Phases 1 and 2 can partially overlap. Phase 3 is independent of Phase 2 (different template set, same YAML). Phase 4 depends on Phase 2's sync concepts being in the schema.

---

## Dealbrain Domain Inventory

Entities that exist in dealbrain, for reference when building YAML definitions:

### Core CRM Entities (synced with Salesforce)
| Entity | Sync Direction | CDC | Electric | Notes |
|--------|---------------|-----|----------|-------|
| opportunity | bidirectional | yes | yes | Core entity. Custom fields via EAV. |
| account | bidirectional | yes | yes | Organization/company records |
| contact | bidirectional | yes | yes | People records |

### Local Entities (no external sync)
| Entity | Electric | Notes |
|--------|----------|-------|
| user | no | WorkOS auth, onboarding state |
| import_job | yes | Async bulk import tracking |
| artifact | no | Uploaded docs/recordings for AI processing |
| transcript | no | Meeting transcripts (Granola webhook) |
| meeting | no | Google Calendar sync |
| email | no | Gmail sync |

### Dynamic Fields (EAV Domain Entities)
| Entity | Electric | Notes |
|--------|----------|-------|
| field_definition | yes | Dynamic field schema (synced from SF, defines custom fields per entity type) |
| field_value | yes | EAV values for custom fields (polymorphic: opportunity/account/contact) |

### AI Processing Entities
| Entity | Electric | Notes |
|--------|----------|-------|
| fact_entity | no | Extracted entities (person, org, product, etc.) |
| fact | no | Extracted facts with 1536D embeddings (pgvector) |
| opportunity_update | yes | LLM-suggested field updates with approval status |

### Sync/Integration Entities
| Entity | Notes |
|--------|-------|
| sync_cdc_event | CDC audit trail (status tracking, dedup via replayId) |
| integration | OAuth tokens + provider config per connection |

### Non-Entity Infrastructure
| System | Technology | Notes |
|--------|-----------|-------|
| Auth | WorkOS | SSO, JWT verification via jose |
| Queue | BullMQ | Event processing, job scheduling |
| Real-time | Electric SQL | Shape subscriptions to frontend |
| LLM | Vercel AI SDK | Claude Sonnet 4.5, GPT-5.2, GPT-4.1-mini |
| Observability | Langfuse | LLM prompt management + tracing |
| Storage | S3 | Document/artifact file storage |
| Cache | Redis | Artifact processing counters |
| Proxy | Cloudflare Workers | Routes /api, /auth to backend |
| Tunnels | Cloudflare Tunnels | Local webhook testing |

### Presentation Layers
| Layer | Technology | Notes |
|-------|-----------|-------|
| REST | NestJS controllers | Webhooks, file uploads, external integrations |
| tRPC | @mguay/nestjs-trpc | Frontend type-safe queries |
| Event handlers | BullMQ processors | Async job processing |

---

## Key Design Decisions

1. **Auth is WorkOS, not per-provider OAuth.** WorkOS handles the SSO/OAuth flow. Provider-specific data (instance_url, scopes) is stored on the integration record but the auth lifecycle is managed by WorkOS.

2. **Repository interfaces only when justified.** Clean-Lite generates concrete repositories by default. Interface + implementation pair only generated when `sync:` is present (adapter pattern needed for external system swap).

3. **Events are first-class citizens.** Not bolted on. The YAML DSL has explicit event declarations that generate typed event classes, handlers, and queue registration.

4. **Electric SQL is opt-in per entity.** Not all entities need real-time frontend sync. The `electric: true` flag controls whether migration and publication are generated.

5. **Field mappings are declarative, not hardcoded.** Entity YAML defines the mapping between local and remote field names. No more `field-mappings.ts` files with manual mappings.

6. **Presets over knobs.** Frontend conventions are captured in named presets. Individual overrides available but not required.

7. **Architecture is an output format, not an input constraint.** The domain model (YAML) is architecture-agnostic. Clean, Clean-Lite, and Vertical Slice are template targets consuming the same input.
