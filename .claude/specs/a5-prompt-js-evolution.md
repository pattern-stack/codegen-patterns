# A5: prompt.js Evolution

## Overview
Extend `templates/entity/new/prompt.js` to consume v2 YAML blocks (family, queries, sync, events) and route to the Clean-Lite-PS template set based on `pipelines.backend.architecture` config.

## Files
| File | Action | Purpose |
|------|--------|---------|
| `templates/entity/new/prompt.js` | modify | Read v2 fields, compute derived vars, expose architecture target |
| `config/paths.mjs` | modify | Export `getPipelinesConfig()` helper |

## New Variables Passed to Templates

### Architecture routing
- `architectureTarget`: `'clean'|'clean-lite'|'clean-lite-ps'|'vertical-slice'` (default: `'clean'`)

### Family
- `family`: string|null — raw from `entity.family`
- `hasFamily`: boolean
- `familyBaseRepository`: `'CrmEntityRepository'|'ActivityEntityRepository'|'KnowledgeEntityRepository'|'MetadataEntityRepository'|null`
- `familyBaseService`: matching service base class name or null

### Queries
- `hasQueries`: boolean
- `processedQueries[]`: each with:
  - `by`, `unique`, `select`, `order`, `limit`, `via` (raw from YAML)
  - `methodName`: derived (e.g., `findByUserId`, `findEmailsByOpportunityId`)
  - `returnType`: `'single'|'array'`
  - `hasVia`, `hasSelect`, `hasOrder`, `hasLimit` convenience flags

**Method name derivation:**
- `by:[user_id]` → `findByUserId`
- `by:[user_id, account_id]` → `findByUserIdAndAccountId`
- `by:[opportunity_id], select:[email]` → `findEmailsByOpportunityId`

### Sync
- `hasSyncBlock`, `syncElectric`, `hasSyncProviders`
- `syncProviders[]`: name, remoteEntity, direction, cdc, fieldMapping (as `{local, remote}[]`), readOnlyFields

### Events
- `hasEvents`
- `processedEvents[]`: name, queue, body (as `{field, type}[]`), generateHandler, `className` (PascalCase+Event), `handlerClassName`

## Acceptance Criteria
- [ ] v1 entities without v2 blocks: all new flags false/empty, no template output change
- [ ] contact-v2.yaml: `family='crm-synced'`, `familyBaseRepository='CrmEntityRepository'`, 6 queries, 3 events, sync with salesforce provider
- [ ] `bun test/run-test.ts compare` produces no diff against existing baseline
