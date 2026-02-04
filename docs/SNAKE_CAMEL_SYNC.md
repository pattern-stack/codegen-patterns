# Codegen Enhancement: Snake/Camel Case Sync

## Problem

When using Electric SQL with Drizzle, 4 layers must stay in sync:

| Layer | Format | Example |
|-------|--------|---------|
| DB columns | snake_case | `owner_user_id` |
| Drizzle properties | camelCase | `ownerUserId` |
| Electric sync | snake_case (default) | needs `columnMapper` |
| FieldMeta / TS types | camelCase | `field: 'ownerUserId'` |

Manual sync is error-prone. Codegen should handle this automatically.

## Solution

From YAML field `owner_user_id`, derive both forms and generate correct code for each layer.

### YAML Input (snake_case - matches DB)

```yaml
fields:
  owner_user_id:
    type: uuid
    foreign_key: users.id
    ui_label: "Owner"
    ui_type: reference
    ui_importance: secondary
```

### Generated Outputs

**1. Drizzle Schema** (`backend/database/schema.ejs.t`)
```typescript
// camelCase property → snake_case column string
ownerUserId: uuid('owner_user_id').notNull().references(() => users.id)
```

**2. Electric Collection** (`frontend/collections/collection.ejs.t`)
```typescript
import { snakeCamelMapper } from '@electric-sql/client';

export const <%= plural %>Collection = createCollection(
  electricCollectionOptions({
    shapeOptions: {
      url: ...,
      columnMapper: snakeCamelMapper(),  // ADD THIS
    },
    schema: <%= name %>Schema,
  }),
);
```

**3. FieldMeta Config** (new template: `frontend/fields/fields.ejs.t`)
```typescript
export const <%= name %>Fields: Record<string, FieldMeta<<%= ClassName %>>> = {
  ownerUserId: {
    field: 'ownerUserId',  // Must be camelCase (matches TS type)
    label: 'Owner',
    type: 'reference',
    importance: 'secondary',
  },
};
```

## Implementation

### Template Changes

1. **prompt.js** - Add `camelName` derivation:
   ```javascript
   const snakeToCamel = (str) => str.replace(/_([a-z])/g, (_, l) => l.toUpperCase());

   fields.forEach(f => {
     f.camelName = snakeToCamel(f.name);  // owner_user_id → ownerUserId
   });
   ```

2. **Drizzle template** - Use camelCase for property, snake_case for column:
   ```ejs
   <%= field.camelName %>: <%= field.drizzleType %>('<%= field.name %>')
   ```

3. **Electric template** - Add columnMapper import and usage

4. **FieldMeta template** (new) - Generate from UI metadata with camelCase keys

### Key Insight

- YAML uses snake_case (source of truth, matches DB)
- Codegen derives camelCase deterministically
- No manual mapping needed anywhere

## References

- `@electric-sql/client` exports `snakeCamelMapper`
- `FieldMeta<T>` enforces `field: keyof T` (compile-time safety)
- Drizzle: `propName: type('column_name')` pattern
