# CREATE-DTO-1 — create DTO: nullable fields must be `.optional()`

**Status:** Draft — ready to build (small, bounded)
**Date:** 2026-05-25
**Origin:** dealbrain-integrations — `POST /accounts` rejected a payload omitting nullable fields (`domain`, `industry`, …) with "Required", because the generated create schema marks them `.nullable()` but not `.optional()`.

---

## Problem

In `templates/entity/new/clean-lite-ps/prompt-extension.js`, `zodChainForCreate(field)` has **mutually-exclusive** branches:

```js
if (nullable) { return base + '.nullable()'; }   // ← nullable fields exit here
if (!required) { return base + '.optional()'; }  // ← unreachable for nullable+optional fields
```

A field that is **both `nullable` and not `required`** (the common case for an optional column — e.g. account `domain`/`industry`) takes the first branch and gets `.nullable()` only. `.nullable()` permits the *value* `null` but the **key is still required** — so a create payload that omits the field is rejected. The YAML says the field is optional; the DTO disagrees.

## Fix

Apply `.nullable()` and `.optional()` **independently**:

```js
function zodChainForCreate(field) {
  const { type, nullable, required, hasDefault, hasChoices, choices } = field;
  if (hasChoices) {
    let base = `z.enum([${choices.map((c) => `'${c}'`).join(', ')}])`;
    if (nullable) base += '.nullable()';
    if (!required) base += '.optional()';
    return base;
  }
  let base = ZOD_TYPE_MAP[type] || 'z.unknown()';
  if (type === 'boolean' && hasDefault) return base + `.default(${field.default ?? false})`;
  if (nullable) base += '.nullable()';
  if (!required) base += '.optional()';
  return base;
}
```

Also fix the **FK create chain** (same file, ~line 1135):
```js
zodChainCreate: rel.nullable ? 'z.string().uuid().nullable().optional()' : 'z.string().uuid()',
```
(a nullable belongs_to FK like `parentAccountId` should be omittable.)

And the **duplicate** `zodChainForCreate` in `templates/relationship/new/prompt.js` (~line 516) — apply the same independent-branch fix for junction create DTOs.

## Decision note

This aligns the create DTO with the YAML's `required` semantics: `required: true` → required key; otherwise omittable (and `null`-accepting if the column is nullable). It does **not** change output/update DTOs.

## Test

`src/__tests__/clean-lite-ps/prompt-extension.test.ts` already asserts `.nullable()` presence — that still passes. **Add** an assertion that a nullable, non-required field's `zodChainCreate` **contains `.optional()`** (and that a required field does not). Run the clean-lite-ps suite (`bun test`).

## Consumer note (dbi)

Unblocks `POST` on Synced entities with optional columns. dbi regenerates (non-destructive on 0.8.1) to pick it up.

## Related
- [BULLMQ-1](BULLMQ-1.md), [OBS-LIST-1](OBS-LIST-1.md).
