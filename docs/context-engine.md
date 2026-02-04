# Context Engine

The Context Engine provides polymorphic relationships and facts for flexible entity-to-entity connections with temporal tracking.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  ENTITIES (Typed Tables)                                        │
│  person │ organization │ opportunity │ engagement               │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────────┐
│  RELATIONSHIP TYPES DSL                                          │
│  entities/relationship_types.yaml - defines valid combinations   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
          ┌────────────────┴────────────────┐
          ▼                                 ▼
┌─────────────────────┐          ┌─────────────────────┐
│  RELATIONSHIPS      │          │  FACTS              │
│  (polymorphic)      │          │  (polymorphic)      │
│  from_type + id     │          │  entity_type + id   │
│  to_type + id       │          │  fact_text          │
│  relationship_type  │          │  tags, confidence   │
└─────────────────────┘          └─────────────────────┘
```

## Components

### Relationship Types DSL

Define valid entity combinations in `entities/relationship_types.yaml`:

```yaml
relationship_types:
  works_at:
    from: [person]
    to: [organization]
    direction: directed
    temporal: true

  stakeholder_on:
    from: [person, organization]
    to: [opportunity]
    direction: directed
    temporal: true
    metadata_schema:
      role:
        type: string
        choices: [decision_maker, influencer, champion, blocker]
```

### Available Relationship Types

| Type | From | To | Description |
|------|------|-----|-------------|
| `works_at` | person | organization | Employment |
| `reports_to` | person | person | Org hierarchy |
| `works_with` | person | person | Peer relationship |
| `stakeholder_on` | person, organization | opportunity | Deal involvement |
| `belongs_to` | opportunity | organization | Account ownership |
| `parent_of` | organization | organization | Company hierarchy |
| `participated_in` | person | engagement | Meeting attendee |
| `related_to_opportunity` | engagement | opportunity | Deal context |
| `related_to_organization` | engagement | organization | Account context |

### Domain Layer

```typescript
// Create a relationship
const relationship = await relationshipRepository.create({
  tenantId: 'tenant-uuid',
  fromEntityType: 'person',
  fromEntityId: 'person-uuid',
  toEntityType: 'organization',
  toEntityId: 'org-uuid',
  relationshipType: 'works_at',
  metadata: { title: 'VP Sales' },
});

// Query relationships
const rels = await relationshipRepository.findByEntity(
  tenantId, 'person', personId
);

// Create a fact
const fact = await factRepository.create({
  tenantId: 'tenant-uuid',
  entityType: 'person',
  entityId: 'person-uuid',
  factText: 'Prefers morning meetings',
  tags: ['preference', 'scheduling'],
  confidenceScore: 0.9,
});

// Query facts by tags
const facts = await factRepository.findByTags(tenantId, ['preference']);
```

### Cascade Delete

When deleting an entity, use `CascadeDeleteService` to clean up related data:

```typescript
@Injectable()
class PersonService {
  constructor(
    private readonly cascadeDelete: CascadeDeleteService,
    private readonly transactionService: TransactionService,
  ) {}

  async deletePerson(tenantId: string, personId: string) {
    return this.transactionService.execute(async (tx) => {
      // Cascade delete facts and relationships first
      await this.cascadeDelete.deleteEntity(tenantId, 'person', personId, tx);
      // Then delete the person
      await this.personRepository.delete(personId);
    });
  }
}
```

## Database Schema

### relationships table

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| tenant_id | uuid | Tenant isolation |
| from_entity_type | enum | person, organization, opportunity, engagement |
| from_entity_id | uuid | Source entity ID |
| to_entity_type | enum | Target entity type |
| to_entity_id | uuid | Target entity ID |
| relationship_type | enum | Type of relationship |
| metadata | jsonb | Additional data (e.g., role) |
| valid_from | timestamp | Start of validity |
| valid_to | timestamp | End of validity (null = current) |
| is_active | boolean | Quick filter for active relationships |
| deleted_at | timestamp | Soft delete |

### facts table

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| tenant_id | uuid | Tenant isolation |
| entity_type | enum | Entity type |
| entity_id | uuid | Entity ID |
| fact_text | text | The fact content |
| tags | text[] | Categorization tags |
| source_type | varchar(50) | Where fact came from |
| source_reference | jsonb | Source details |
| confidence_score | decimal(3,2) | 0.00-1.00 confidence |
| is_active | boolean | Active/invalidated |
| valid_from | timestamp | When fact became true |
| valid_to | timestamp | When fact stopped being true |
| deleted_at | timestamp | Soft delete |

## Migrations

Run migrations to create the tables:

```bash
cd app/backend
bun run db:migrate
```

## Module Import

Import `ContextEngineModule` to get all functionality:

```typescript
import { ContextEngineModule } from './modules/context-engine.module';

@Module({
  imports: [ContextEngineModule],
})
export class AppModule {}
```

This exports:
- `RELATIONSHIP_REPOSITORY` - Relationship data access
- `FACT_REPOSITORY` - Fact data access
- `TransactionService` - Transaction wrapper
- `CascadeDeleteService` - Cascade delete helper

## Next Steps

### Phase 2: Embeddings & Semantic Search

1. **Add pgvector extension**
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```

2. **Add embedding column to facts**
   ```sql
   ALTER TABLE facts ADD COLUMN fact_embedding vector(3072);
   CREATE INDEX idx_facts_embedding ON facts
     USING ivfflat (fact_embedding vector_cosine_ops);
   ```

3. **Create EmbeddingService**
   - Call OpenAI text-embedding-3-large API
   - Auto-generate embeddings on fact create/update
   - Add `searchSimilar()` to FactRepository

### Phase 3: Entity Resolver & Caching

1. **EntityResolverService** - Resolve any entity by type+id
2. **Redis caching** for relationship lookups
3. **Graph traversal** helpers

### Phase 4: AI Integration

1. **Fact extraction** from engagement transcripts
2. **Relationship inference** from communication patterns
3. **Context assembly** for AI prompts
