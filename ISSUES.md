# Codegen Generator Issues

Issues discovered while testing against dealbrain project.

## Issue 1: Type naming convention

**Current:** Generator uses `OpportunityEntity` as the type name
**Expected:** `Opportunity` (no `Entity` suffix)

**Location:** `templates/entity/new/frontend/entity/types.ejs.t`

**Details:**
- Dealbrain's `@repo/db/schema/client` exports `Opportunity`, not `OpportunityEntity`
- Generator assumes `{ClassName}Entity` convention
- Need config option: `typeNaming: 'entity' | 'plain'` (default: 'entity')

---

## Issue 2: FK resolution imports non-existent collections

**Current:** Always generates `import { userCollection } from './user'` when entity has `belongs_to` relation
**Expected:** Skip FK resolution when target collection doesn't exist

**Location:** `templates/entity/new/frontend/entity/collection.ejs.t` lines 30-31, 40-47

**Details:**
- `existingBelongsTo` filter checks if domain entity file exists, not if frontend collection exists
- For frontend, should check if `generated/collections/{target}.ts` exists
- Or add config option to disable FK resolution entirely: `generate.fkResolution: false`

---

## Issue 3: URL not wrapped in constructor (useTableParam: false)

**Current:** `url: \`${API_BASE_URL}/opportunities\``
**Expected:** `url: new URL(\`${API_BASE_URL}/opportunities\`, window.location.origin).toString()`

**Location:** `templates/entity/new/frontend/entity/collection.ejs.t` line 54

**Details:**
- The `wrapInUrlConstructor` config only applies when `useTableParam: true` (lines 40-46)
- The `useTableParam: false` branch (line 54) doesn't wrap the URL
- Should apply URL wrapping regardless of `useTableParam` when `wrapInUrlConstructor: true`

---

## Issue 4: Collection naming (singular vs plural)

**Current:** `opportunityCollection` (singular entity name)
**Expected:** `opportunitiesCollection` (plural)

**Location:** `templates/entity/new/frontend/entity/collection.ejs.t` line 35

**Details:**
- Generator uses `<%= camelName %>Collection` which is singular
- Should use `<%= plural %>Collection` for consistency with collection ID
- Or add config option: `collectionNaming: 'singular' | 'plural'`

---

## Issue 5: File naming (singular vs plural)

**Current:** `generated/collections/opportunity.ts`
**Expected:** `generated/collections/opportunities.ts`

**Location:** `templates/entity/new/frontend/entity/collection.ejs.t` line 2

**Details:**
- Uses `${name}` (singular) in path
- Should use `${plural}` for consistency
- Or add config option: `fileNaming: 'singular' | 'plural'`

---

## Issue 6: Hook return shape

**Current:** `return { data: ..., isLoading }`
**Expected:** `return { opportunities: ..., isLoading }` (entity-specific key)

**Location:** `templates/entity/new/frontend/entity/hooks.ejs.t` lines 15-18

**Details:**
- Generic `data` key works but entity-specific key (`opportunities`) is more ergonomic
- Could be config option: `hookReturnStyle: 'generic' | 'named'`

---

## Priority

1. **High:** Issue 2 (FK resolution) - causes TypeScript errors
2. **High:** Issue 1 (type naming) - causes TypeScript errors
3. **Medium:** Issue 3 (URL wrap) - functional difference
4. **Low:** Issues 4, 5, 6 - naming conventions, non-breaking

---

## Suggested Config Additions

```yaml
generate:
  # Type naming: 'entity' = OpportunityEntity, 'plain' = Opportunity
  typeNaming: "plain"

  # Skip FK resolution (useful when related collections don't exist)
  fkResolution: false

  # Collection variable naming: 'singular' = opportunityCollection, 'plural' = opportunitiesCollection
  collectionNaming: "plural"

  # File naming: 'singular' = opportunity.ts, 'plural' = opportunities.ts
  fileNaming: "plural"

  # Hook return key: 'generic' = { data }, 'named' = { opportunities }
  hookReturnStyle: "named"
```
