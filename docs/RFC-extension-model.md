# RFC: Codegen Extension Model — Tiered Cascade for Surviving Regen

**Status:** Draft — proposal for discussion
**Date:** 2026-04-19
**Author:** Doug + Claude
**Relates to:** `docs/RFC-app-defined-patterns.md` (complementary — Patterns vs Extensions), PR [#57](https://github.com/pattern-stack/codegen-patterns/pull/57) (runtime vendoring precedent), issue [#60](https://github.com/pattern-stack/codegen-patterns/issues/60) + [#59](https://github.com/pattern-stack/codegen-patterns/issues/59) (subsystem proposals)

---

## Summary

Codegen-patterns today force-overwrites every generated file on regen. Consumers who hand-extend a generated file protect it by (a) adding a `HAND-EXTENDED GENERATED FILE` banner, (b) registering it in a project-local `docs/hand-extended-generated-files.md`, and (c) manually running `git checkout HEAD -- <path>` after regen to restore their edits. This is a paper policy. It works until it doesn't — and when it doesn't, it fails silently.

**Field evidence (dealbrain-v2, session on 2026-04-19):** a single `pts codegen gen-all` run clobbered **6 hand-extended files**. 2 were registered and rescued. 4 were not registered and were caught only when TypeScript failed, after the regen had already rewritten them. One of the 4 introduced a dependency-injection failure that required investigation to diagnose.

This RFC proposes a **three-tier cascade** that replaces the paper policy with tool-enforced contracts. Each tier handles the class of hand-extension the previous can't express:

1. **Tier 1 — Extensions:** sibling `<name>.extensions.ts` file; merge at the language level
2. **Tier 2 — Sentinels:** `@codegen:preserve` regions inside a generated file; splice on regen
3. **Tier 3 — Banner + Diff:** regen-to-scratch, diff against current, halt with alert

Consumers opt into whichever tier fits the edit. Tools enforce each. Paper registry becomes unnecessary.

---

## Motivation

### Today's failure mode

The `docs/hand-extended-generated-files.md` registry in dealbrain-v2 documents 5 files with hand extensions. This session's regen clobbered 4 files NOT in the registry — silently. The human layer (developer remembering to add an entry to the registry + a banner to the file) failed, and there was no tool to catch the regression.

Files clobbered this session:

| File | Registered? | Extension class |
|---|---|---|
| `field_values/field_value.service.ts` | ✅ | Added two compound methods |
| `field_values/field_value.entity.ts` | ✅ | Added composite `uniqueIndex` |
| `field_values/field_value.repository.ts` | ✅ | Added upsert with composite conflict target |
| `field_values/field_values.module.ts` | ✅ | Added FieldDefinitionsModule import |
| `field_definitions/field_definitions.module.ts` | ✅ | Exported the repository |
| `integrations/integration.service.ts` | ❌ | Added three decryption helpers |
| `integrations/integration.repository.ts` | ❌ | Added `findActiveByUser` |
| `integrations/integrations.module.ts` | ❌ | Registered OAuth use-case quartet |
| `opportunities/opportunities.module.ts` | ❌ | Exported repository (pre-ADR-002) |
| `accounts/accounts.module.ts` | ❌ | Same |
| `contacts/contacts.module.ts` | ❌ | Same |
| `opportunity_contacts/opportunity_contacts.module.ts` | ❌ | Same |

5 of 12 hand-extensions were unprotected. Regen treated them identically to fresh scaffold.

### Why sentinels alone don't solve it

Sentinels (the "classic" approach — `// @codegen:begin-preserve X ... // @codegen:end-preserve X`) handle "add a line inside this block" well. They fail when the extension needs to:

- Change a class's parent (can't wrap inheritance in a sentinel)
- Add a new import not colocated with a sentinel
- Modify a constructor signature (dependency injection positional order)

Several of the files above are structurally outside what sentinels can express.

### Why extension files alone don't solve it

Extension files (sibling `<name>.extensions.ts` that the generated file merges from) are architecturally clean for behavioral additions — mixin methods, providers, imports — but **fail for value-level additions to a generated construct.** Drizzle's `pgTable(...)` is a value, not a class:

```ts
export const field_values = pgTable('field_values', {
  id: uuid(...).primaryKey(),
  // ... columns ...
}, (t) => ({
  // ← can't add a composite uniqueIndex here from a sibling file;
  //   pgTable's second-arg constraints block is a literal.
}));
```

You literally cannot extend this via inheritance or mixin. The sentinel approach is the only lightweight option.

### Why a registry-only solution is insufficient

Today's `docs/hand-extended-generated-files.md` is the registry approach. It's a documentation artifact, not an enforcement mechanism. The evidence is above — 7 of 12 unprotected.

A machine-readable registry (e.g. `.codegen/protected.yaml`) with a regen-time failure on drift is strictly better than today. But without the extension/sentinel mechanisms, every protected file becomes a manual merge every regen. That's a tax, not a solution.

---

## The Proposal

### Three-tier cascade

Each generated file, at regen time, resolves to exactly one of four outcomes:

```
For each <path> codegen would write:
┌─────────────────────────────────────────────────────────┐
│ 1. Does sibling <path>.extensions.ts exist?             │
│    → Tier 1. Write generated file fresh. Leave          │
│      extension file alone. Done.                        │
├─────────────────────────────────────────────────────────┤
│ 2. Does existing <path> contain @codegen:preserve       │
│    markers?                                             │
│    → Tier 2. Parse preserve-regions from current file.  │
│      Regen new version. Splice regions back in at       │
│      matching @codegen:insertion-point markers.         │
│      Fail if new file lacks a matching insertion        │
│      point for any preserved region.                    │
├─────────────────────────────────────────────────────────┤
│ 3. Does existing <path> carry a HAND-EXTENDED GENERATED │
│    FILE banner?                                         │
│    → Tier 3. Regen to <path>.codegen-new. Do NOT        │
│      overwrite. Emit diff + halt with actionable        │
│      message: "protected file has pending regen; run    │
│      pts codegen reconcile <path> to merge."            │
├─────────────────────────────────────────────────────────┤
│ 4. None of the above.                                   │
│    → Overwrite freely. Baseline contract.               │
└─────────────────────────────────────────────────────────┘
```

Consumers can stack tiers on the same file. A file with both a banner AND preserve regions: Tier 2 splices the markers and Tier 3 alerts if the non-marker regions diverge. A file with an extensions sibling AND preserve regions inside itself: Tier 1 applies (extension file is authoritative), Tier 2 markers in the generated file get overwritten because the generated file is the codegen's responsibility.

### Tier 1 — Extension files

**When to use:** adding methods to a class, additional providers to a NestJS module, new imports, additional schema validators.

**Convention:**
- Generated file: `src/modules/field_values/field_value.service.ts` (fully owned by codegen)
- Extension file: `src/modules/field_values/field_value.service.extensions.ts` (fully owned by consumer)
- Generated file imports a `mixExtensions()` helper and applies extensions when the sibling exists

**Shape (illustrative):**

```ts
// field_value.service.ts (generated, always rewritten)
import { FieldValueServiceExtensions } from './field_value.service.extensions'; // optional import, bypassed if missing

export class FieldValueServiceBase extends WithAnalytics(BaseService<...>) {
  constructor(protected readonly repository: FieldValueRepository) { super(repository); }
}

export class FieldValueService extends applyExtensions(FieldValueServiceBase, FieldValueServiceExtensions) {}
```

```ts
// field_value.service.extensions.ts (consumer-owned, never touched)
export function FieldValueServiceExtensions(Base: typeof FieldValueServiceBase) {
  return class extends Base {
    async upsertFieldsTransactional(...): Promise<void> { /* hand-written */ }
    async findMergedByEntity(...): Promise<Record<string, unknown>> { /* hand-written */ }
  };
}
```

This works for ~80% of the clobbered files in the evidence table — every pure method-addition case.

### Tier 2 — Sentinels

**When to use:** adding a column or constraint to a Drizzle `pgTable`, adding entries to a `@Module({...})` array, modifying a `NestFactory.create({...})` options object.

**Marker format:**

```ts
// Generated file emits named insertion points where extensions are permitted:
export const field_values = pgTable('field_values', {
  // ... columns ...
}, (t) => ({
  // @codegen:insertion-point pgtable-constraints
}));
```

Consumers add:

```ts
export const field_values = pgTable('field_values', {
  // ... columns ...
}, (t) => ({
  // @codegen:insertion-point pgtable-constraints
  // @codegen:begin-preserve composite-unique
  fieldValuesEntityTypeEntityIdFieldDefIdUq: uniqueIndex(
    'field_values_entity_type_entity_id_field_def_id_uq'
  ).on(t.entityType, t.entityId, t.fieldDefinitionId),
  // @codegen:end-preserve composite-unique
}));
```

On regen: codegen parses `@codegen:begin-preserve X ... @codegen:end-preserve X` blocks out of the existing file. Regenerates the base. Finds `// @codegen:insertion-point pgtable-constraints` in the new file. Inserts preserved blocks at that location. Writes the merged result.

**Failure modes:**
- Preserved block refers to a marker no longer present in the generated template → halt with message "insertion point `pgtable-constraints` removed from template; please resolve `<name>` manually"
- Two preserved blocks have the same name → halt with duplicate error
- Preserved block is structurally malformed (JS parser can't round-trip) → halt

This handles the Drizzle `pgTable` case cleanly. Several modules-file cases too, though Tier 1 is often preferable when the latter applies.

### Tier 3 — Banner + diff + halt

**When to use:** deep structural changes that don't fit sentinels or extensions — e.g., rewriting a generated class hierarchy, or temporarily patching while a tier-1/2 solution is being designed.

**Mechanics:**
- Generated file carries a banner: `/** HAND-EXTENDED GENERATED FILE — see docs/hand-extended-generated-files.md */`
- On regen, codegen detects banner, writes new version to `<path>.codegen-new` instead of `<path>`
- Codegen halts with a diff + message: `"Protected file <path> has divergent regen output. Run 'pts codegen reconcile <path>' to merge interactively."`
- CI fails cleanly (non-zero exit, actionable message)
- Consumer runs `pts codegen reconcile <path>` — opens the diff in their editor's merge tool

This is the escape hatch. Deliberately painful — it forces the developer to look at the diff and decide. No silent merges.

**Registry role:** `docs/hand-extended-generated-files.md` becomes reference documentation (the "why" — an architectural record). The banner IS the enforcement mechanism. Registry entries should still exist for auditability, but the banner is what codegen checks.

---

## Detection + cascade logic

Pseudo-code for the codegen writer:

```ts
async function writeGenerated(path: string, newContent: string): Promise<void> {
  const extensionSibling = path.replace(/\.ts$/, '.extensions.ts');

  if (await fs.exists(extensionSibling)) {
    // Tier 1 — write generated file fresh, extension file untouched
    await fs.writeFile(path, newContent);
    return;
  }

  const current = await fs.exists(path) ? await fs.readFile(path) : null;

  if (current && hasPreserveMarkers(current)) {
    // Tier 2 — splice preserved regions into new content
    const merged = splicePreservedRegions(current, newContent); // may throw
    await fs.writeFile(path, merged);
    return;
  }

  if (current && hasHandExtendedBanner(current)) {
    // Tier 3 — write to scratch, halt
    await fs.writeFile(`${path}.codegen-new`, newContent);
    throw new RegenHaltError(path, 'banner-protected');
  }

  // Baseline — overwrite
  await fs.writeFile(path, newContent);
}
```

Failure reporting is the whole value. `RegenHaltError` bubbles up to the CLI with actionable recovery commands. CI integrations halt cleanly.

---

## Relationship to existing concepts

### Patterns (RFC-app-defined-patterns.md)

**Orthogonal.** Patterns contribute behavior *into* generated code via YAML opt-in (`patterns: [Eav]`). Extensions hand-edit generated code *after* generation. Patterns reduce the need for extensions (many of today's hand-extensions would be better expressed as patterns), but don't eliminate it — some hand-edits are app-specific, one-off, or exploratory. Both coexist.

Concretely: the `field_value.service.ts` extensions (`upsertFieldsTransactional`, `findMergedByEntity`) would ideally be contributed by an `EavPattern`. Until Patterns land, they're hand extensions requiring Tier 1 protection.

### Behaviors + families

**Orthogonal.** Behaviors add columns/hooks from YAML. Families provide method-carrying base classes. Neither interacts with the extension model. Regen semantics for files that use behaviors or family bases are unchanged by this proposal.

### Runtime vendoring (PR #57 pattern)

**Complementary.** Runtime vendoring (via `init-scaffold.ts`'s `VENDORED_RUNTIME_FILES`) copies library primitives into consumer `src/shared/` on `codegen init`. Those files never regen — `init-scaffold.ts` only runs once per project. This proposal adds regen-safety for the *generated* files that DO regen.

### Issue [#60](https://github.com/pattern-stack/codegen-patterns/issues/60) (sync engine subsystem)

**Complementary.** The sync engine subsystem ships generic primitives. Per-entity sinks and per-provider strategies stay in consumer code and never regen. The extension model affects the codegen-owned entity modules that wrap the subsystem — same seam, different content.

---

## Consumer migration

For an existing project with a `docs/hand-extended-generated-files.md`-style registry:

1. **Audit each registered file** — classify its extensions into Tier 1 / 2 / 3.
2. **Port Tier 1 candidates** — create sibling `<name>.extensions.ts` files, move extensions into the mixin-factory shape. Generated file is rewritten (cleanly) on next regen.
3. **Port Tier 2 candidates** — add `@codegen:insertion-point X` to the template (upstream work) and `@codegen:begin-preserve X / @codegen:end-preserve X` around the hand-written region.
4. **Leave residue on Tier 3** — files that can't fit 1 or 2 keep the banner, rely on halt-on-regen to enforce manual review.
5. **Delete the registry's enforcement role** — `docs/hand-extended-generated-files.md` stays as architectural documentation. Regen no longer consults it.

Dealbrain-v2 would be the first test case: 12 hand-extensions to classify. Expected distribution based on this session's evidence: ~8 Tier 1 (method/provider/export additions), ~3 Tier 2 (Drizzle pgTable constraint, module array literal), ~1 Tier 3 (if any).

---

## Phased shipping

Tiers are independent; ship in increasing order of upstream complexity:

### Phase A — Tier 3 only (quick win, ~100 LOC)

Banner detection + regen-to-scratch + halt. Catches today's silent-clobber problem immediately. Zero template changes. Opt-in via banner + registry.

Lands as a standalone PR. Consumers add banners to protect files. Old registry remains as documentation.

### Phase B — Tier 1 (~300–500 LOC + convention)

Extension-file detection + `applyExtensions` runtime helper + updated templates that import-if-present + docs explaining the mixin-factory convention.

Requires every generated module to restructure slightly (export `XxxBase` + final `Xxx` that applies extensions). Non-trivial template churn; downstream regressions likely until stable.

Lands as a separate PR after Phase A is proven.

### Phase C — Tier 2 (~500–800 LOC)

Insertion-point markers in every generated file + preserve-block parsing + splice logic + round-trip tests. Biggest template surface area touched.

Lands last because it's the highest-risk change — any template ships broken markers break every consumer's next regen.

---

## Open questions

### Q1 — extension file location

Should `<name>.extensions.ts` live next to the generated file (`src/modules/field_values/field_value.service.extensions.ts`) or in a parallel `extensions/` directory (`src/modules/field_values/extensions/field_value.service.ts`)? Colocation keeps related code together; separation makes extension files easier to audit. Leaning colocation.

### Q2 — multiple extensions per file

Does Tier 1 allow composition? E.g., can a consumer's module provide BOTH `FieldValueServiceExtensions` AND `FieldValueServiceAnalyticsExtensions`? If yes: extension file exports an array; generated file applies them in order. Extra complexity; worth it only if real use cases emerge.

### Q3 — Tier 2 marker syntax

`@codegen:begin-preserve X` vs `@codegen:preserve:X start` vs `<codegen:preserve name="x">...</codegen:preserve>` — JSDoc-style vs XML-style vs inline. Proposal: JSDoc-style (`@codegen:begin-preserve X ... @codegen:end-preserve X`) because it parses trivially with a regex and doesn't interfere with TypeScript syntax.

### Q4 — Tier 3 granularity

Current proposal: halt on ANY diff in a banner-protected file. Alternative: halt only if the diff touches specific AST regions (e.g., class body vs imports). Former is simpler and honest about the problem; latter is smart but introduces more ways to silently merge.

Leaning simple.

### Q5 — CI integration

How should CI consume Tier 3 halts? Options: exit non-zero with message (current proposal), write a machine-readable report (`.codegen/pending-reconciliations.json`), both. CI-config templates could include a `pts codegen check` step that runs a dry regen and reports pending reconciliations without writing anything. Worth specifying in Phase A.

### Q6 — Relation to `docs/hand-extended-generated-files.md`

If the banner is enforcement, is the registry obsolete? Proposal: keep registry as reference documentation (the "why" — explaining *why* a given file is hand-extended) but remove its enforcement role. Registry becomes advisory; banner becomes authoritative.

---

## Not in scope

- **Rewriting existing templates to emit extension-factory patterns** — only needed during Phase B. Defer until that phase is scoped.
- **Live-reload / watch-mode regen behavior** — Tier 3 halts interact awkwardly with watch mode. Design that when watch mode matures; for now, watch mode skips Tier 3 protection and emits warnings instead.
- **Cross-project extension sharing** — if multiple consumers need the same extension (e.g., every CRM app wants the EAV methods), use Patterns (the other RFC), not extensions. Extensions are app-local by design.
- **Generative AI-assisted reconciliation** — an agent could read a Tier 3 diff and propose a merge. Interesting direction; out of scope for this RFC.

---

## Next steps

1. **Ship Phase A** — banner detection + halt — as a standalone PR. Smallest useful delta. Land-and-learn.
2. **Port dealbrain-v2** — use the 12 hand-extensions from this session's evidence as the first stress test. Publish a retrospective document from consumer perspective.
3. **Iterate Phase B design** — the mixin-factory convention in Tier 1 is the most debatable piece. Prototype in dealbrain-v2, then upstream.
4. **Defer Phase C** until A and B are stable and a real extension exists that genuinely needs Tier 2 (the Drizzle `pgTable` case from this session).

Phased delivery means consumers get value immediately (Tier 3 stops silent clobbers today) without waiting for the full model to ship.
