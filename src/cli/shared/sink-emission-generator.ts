/**
 * Default `IIntegrationSink` emitter (RFC-0002 §4, Track D · E1).
 *
 * Per (surface, entity-with-`surface:` + `pattern: Integrated`), emits the TEXT
 * of `src/integrations/<surface>/sinks/<entity>.sink.ts` — an **emit-once
 * scaffold** (carries the `// <CODEGEN-SCAFFOLD-V1>` sentinel; regen skips an
 * existing file so an author override survives). Sibling to
 * `adapter-emission-generator.ts`; this file is the *pure emitter* only — the
 * caller (E2) builds {@link SinkEmitInput} from the entity definition +
 * locations config and owns all filesystem wiring.
 *
 * ## What is generated vs. author-owned (RFC-0002 §4)
 *
 * The sink's PLUMBING is generated: constructor `(repo, provider)` with the
 * provider bound at construction; the provider-match assert in
 * `upsertByExternalId` (a mismatch is a wiring bug → throw); delegation to the
 * `integrated` repo's `findByExternalIdProjected` / `integrationUpsertOne` /
 * `softDeleteByExternalId`; `userId` scoping; and the `{ id, saved }` return
 * shapes.
 *
 * The `write` object is **fully generated** — no `TODO(author)` seams:
 *   - Scalar copy-through fields (`fields:` entries, FK columns excluded) emit as
 *     `<camelName>: record.<camelName>`. `type: json` columns copy through the
 *     same way (the write-type member is `unknown`, matching the template's
 *     `TS_TYPE_MAP.json` mapping — a typed json shape is a find-side concern, #488).
 *   - FK external join-keys emit as active `<rel>ExternalId: record.<rel>ExternalId`
 *     copy-throughs. The write-key derivation mirrors `processBelongsTo`'s
 *     `relationKey` branches (`prompt-extension.js:447-460`); see `fkWriteKey()`
 *     in `adapter-emission-generator.ts`.
 *
 * The remaining author seam is the `<Entity>Canonical` type alias at the top of
 * the generated file: widen it from the default `<Entity>IntegrationProjection`
 * to your adapter's canonical shape whenever the adapter carries fields the
 * projection does not (e.g. FK external keys resolved by the vendor API). The
 * generated `record.<rel>ExternalId` access assumes the canonical type carries
 * that key — RFC-0004 / #489 track canonical ownership long-term.
 *
 * Policy methods (delete semantics, per-field exclusions) are #491/#490 scope.
 *
 * ## Find-side reshaping (generated vs. author seam) — #488
 *
 * `findByExternalId` returns a generated **explicit projection → canonical
 * reshaping view** rather than a bare `return row`. Every field is a BARE
 * passthrough (`<f>: row.<f>`) — no `??` coercion and no `as` cast:
 *
 * GENERATED (resolver-correct, diff-sound):
 *   - Explicit `const view: <Entity>Canonical = { … }; return view;` — full
 *     projection field enumeration: id, externalId, copy-through fields, local
 *     FK columns, and (if declared) createdAt/updatedAt.
 *   - BARE passthrough for every field — **preserves `null` so the orchestrator's
 *     `DeepEqualDiffer` converges to noop** (`null ≠ ''`; a blanket `?? ''`
 *     coercion would make every legitimately-null column diff false, producing
 *     a spurious upsert that never converges; `deep-equal.differ.ts:187-208`).
 *   - `type: json` columns pass through at `unknown` (no `as` cast available;
 *     a typed cast is the author's seam, surfaced as a compile error on widen).
 *
 * AUTHOR SEAM (surfaced as compile errors when you widen `<Entity>Canonical`):
 *   - Typed-json narrowing (`unknown → MyType[]`) — no cast-free generator
 *     solution; the compile error on widen routes you here.
 *   - ALL null-coercion defaults (`?? ''`, `?? 0`, `?? false`, `?? 'unknown'`) —
 *     added only when a member is widened to non-null; TS forces the choice.
 *   - External-key reconstruction on the find side — `accountExternalId` from
 *     a local `accountId` requires a resolve; the projection does NOT carry it.
 *   - Dropping local-only projection columns when you widen the canonical —
 *     delete the corresponding `<f>: row.<f>` line.
 *
 * ## `userId` is NOT injected — it is a declared field (see §4 deviation note)
 *
 * The generated `<Entity>IntegrationWrite` interface has NO `userId` member
 * unless the entity declares a `user_id` field (then it is an ordinary
 * copy-through column — `templates/.../repository.ejs.t` lists it in
 * `writeColumns`/`writeFields`). The base repo's `integrationUpsertOne` reads
 * `w['userId']` only inside the EAV dual-write branch
 * (`integrated-entity-repository.ts:139`); the non-EAV insert builds `values`
 * purely from `externalId` + `writeColumns` + resolved FKs + timestamps. So:
 *   - if the entity declares `user_id`, `userId` is sourced from the **method
 *     parameter** (the authenticated swe-brain user — the vendor payload does
 *     not know it), emitted as a bare `userId,` shorthand — matching swe-brain's
 *     hand-authored sinks, which emit `userId,` and NOT `userId: record.userId`
 *     even though `userId` is a copy-through column;
 *   - if the entity does NOT declare `user_id` (e.g. the `contact` fixture),
 *     there is no `userId` member on `<Entity>IntegrationWrite` and the write
 *     object omits it entirely.
 * Either way the `write` object type-checks against `<Entity>IntegrationWrite`
 * by explicit field enumeration — never a spread/cast (CLAUDE.md: no casts).
 */

import { subsystemsImport, type RuntimeMode } from "./runtime-import";

const SCAFFOLD_SENTINEL = "// <CODEGEN-SCAFFOLD-V1>";

/** The camelCase name of the user-scoping field — sourced from the sink's
 *  `userId` parameter rather than the canonical record. */
const USER_ID_FIELD = "userId";

// ============================================================================
// Input
// ============================================================================

/** One copy-through scalar column on the integration write/projection surface.
 *  Mirrors `buildIntegrationSurface().writeFields` in the clean-lite-ps
 *  prompt-extension: `camelName` + nullable-aware `tsType`. */
export interface SinkCopyThroughField {
  /** camelCase column name (e.g. `email`, `userId`). */
  camelName: string;
  /** nullable-aware TS type (`string`, `string | null`, `Date`, …). Carried for
   *  parity with the repo template; the sink body itself does not re-type it. */
  tsType: string;
}

/** One external FK join-key on the integration write surface. Mirrors
 *  `buildIntegrationSurface().writeFkFields`: `<relationKey>ExternalId`,
 *  always `string | null`. Emitted as an active `<writeKey>: record.<writeKey>`
 *  copy-through; the author widens `<Entity>Canonical` when the adapter's
 *  canonical carries the external key (RFC-0004 / #489 track canonical ownership). */
export interface SinkFkExternalKey {
  /** Write-surface key name, e.g. `accountExternalId`. */
  writeKey: string;
}

/** Pure input for {@link generateDefaultSink}. The caller (E2) derives this from
 *  the entity definition + locations config; nothing here is path-computed
 *  inside the emitter (the repo import is passed as `repoImportSpecifier`). */
export interface SinkEmitInput {
  /** Entity name, snake_case singular (`contact`). For messages only. */
  entityName: string;
  /** PascalCase entity class (`Contact`). Drives the sink + type names. */
  entityClass: string;
  /** Surface tag (`crm`). For the doc banner only. */
  surface: string;
  /** Resolved pattern name. MUST be `Integrated` or the emitter throws. */
  pattern: string;
  /** Bare provider slug bound at construction (`google`, `hubspot`). */
  provider: string;
  /** Copy-through scalar columns — the entity's `fields:` block (FK columns
   *  excluded), exactly as the repo template's `writeFields`. */
  copyThroughFields: SinkCopyThroughField[];
  /** External FK join-keys — one per belongs_to, exactly as the repo template's
   *  `writeFkFields`. */
  fkExternalKeys: SinkFkExternalKey[];
  /** Module specifier the generated repo + projection + write types import
   *  from (e.g. `../../../crm/contacts/contact.repository`). Caller-computed. */
  repoImportSpecifier: string;
  /** Runtime mode (ADR-037) — selects the `IIntegrationSink` import specifier.
   *  Defaults to `package` when omitted. */
  mode?: RuntimeMode;
  /** Whether the entity declares `timestamps` behavior (`created_at`/`updated_at`
   *  columns). When true, the find-side view enumerates `createdAt`/`updatedAt`
   *  as bare passthroughs — required because the projection-default canonical
   *  (`<E>IntegrationProjection`) includes timestamps and TS requires all members.
   *  Sourced from the same `hasTimestamps` flag the template uses
   *  (`prompt-extension.js:1108`). Defaults to false when omitted. */
  hasTimestamps?: boolean;
  /** Local FK column camelNames carried on the projection (e.g. `accountId`
   *  for a `belongs_to(account)` with `foreign_key: account_id`). Enumerated
   *  as bare scalar passthroughs in the find-side view, in projection order
   *  (after copy-through fields, before timestamps). Mirrors `belongsTo.map(rel
   *  => rel.camelField)` from `projectionFields` in `buildIntegrationSurface`
   *  (`prompt-extension.js:940-943`). Defaults to empty when omitted. */
  localFkColumns?: SinkCopyThroughField[];
}

// ============================================================================
// Names
// ============================================================================

interface SinkNames {
  sinkClass: string; // ContactSink
  canonicalType: string; // ContactCanonical
  repoClass: string; // ContactRepository
  projectionType: string; // ContactIntegrationProjection
  writeType: string; // ContactIntegrationWrite
}

function sinkNames(entityClass: string): SinkNames {
  return {
    sinkClass: `${entityClass}Sink`,
    canonicalType: `${entityClass}Canonical`,
    repoClass: `${entityClass}Repository`,
    projectionType: `${entityClass}IntegrationProjection`,
    writeType: `${entityClass}IntegrationWrite`,
  };
}

// ============================================================================
// Emitter
// ============================================================================

/**
 * Emit the default `IIntegrationSink` scaffold for a `pattern: Integrated`
 * entity. Throws when the entity is not `Integrated` (the only family with the
 * `integrationUpsertOne`/projection path) — never returns a non-compiling sink.
 */
export function generateDefaultSink(input: SinkEmitInput): string {
  if (input.pattern !== "Integrated") {
    throw new Error(
      `cannot emit default integration sink for entity '${input.entityName}': ` +
        `it is 'pattern: ${input.pattern}', but the default sink is emittable ` +
        `only for 'pattern: Integrated' entities (the only family with the ` +
        `integrationUpsertOne / findByExternalIdProjected projection path). ` +
        `Add 'pattern: Integrated' to the entity or provide a hand-authored sink.`,
    );
  }

  const n = sinkNames(input.entityClass);

  // The `write` object, built by explicit field enumeration so it type-checks
  // against <Entity>IntegrationWrite with no spread/cast.
  //   - externalId — always present.
  //   - copy-through fields, one `<field>: record.<field>` line each, EXCEPT
  //     `userId` which is sourced from the method param (a bare `userId,`).
  //   - FK external join-keys — active copy-through lines (the author widens
  //     <Entity>Canonical when the canonical carries those keys).
  const hasUserIdField = input.copyThroughFields.some(
    (f) => f.camelName === USER_ID_FIELD,
  );
  const copyThroughLines = input.copyThroughFields
    .filter((f) => f.camelName !== USER_ID_FIELD)
    .map((f) => `      ${f.camelName}: record.${f.camelName},`);
  const fkLines = input.fkExternalKeys.map(
    (fk) => `      ${fk.writeKey}: record.${fk.writeKey},`,
  );

  const writeBodyLines: string[] = [
    `      externalId: record.externalId,`,
  ];
  if (copyThroughLines.length > 0) {
    writeBodyLines.push(
      `      // copy-through fields (one line per \`fields:\` entry):`,
      ...copyThroughLines,
    );
  }
  if (fkLines.length > 0) {
    writeBodyLines.push(
      `      // FK external join-keys (copy-through from the canonical record):`,
      ...fkLines,
    );
  }
  if (hasUserIdField) {
    // `userId` is sourced from the authenticated-user param, not the vendor
    // record — matches swe-brain's hand-authored sinks.
    writeBodyLines.push(`      userId,`);
  }
  const writeBody = writeBodyLines.join("\n");

  // The find-side reshaping view — explicit projection → canonical enumeration.
  // BARE passthrough for every field: `<f>: row.<f>` — no `??` coercion, no
  // `as` cast. Preserves `null` so the orchestrator's DeepEqualDiffer converges
  // to noop (null !== '' — deep-equal.differ.ts:187-208). The projection-default
  // canonical is exactly the projection shape, so bare passthrough type-checks.
  // When the author widens a member to non-null, the bare line becomes a compile
  // error — they add `?? <default>` at that exact member. The generator never
  // chooses a default; the compile error routes the human to the decision.
  // Projection order: id, externalId, copy-through, local FK columns, timestamps.
  const findViewLines: string[] = [
    `    id: row.id,`,
    `    externalId: row.externalId,`,
  ];
  for (const f of input.copyThroughFields) {
    const isJson = f.tsType.startsWith("unknown");
    if (isJson) {
      // SEAM (typed json): `unknown` passes through; typed-narrowing is author-owned.
      // When you widen the canonical to a concrete type (e.g. MyType[]), this line
      // becomes a compile error — that is intentional: no cast-free generator
      // solution exists; you supply the typed narrowing (or a safe runtime guard).
      findViewLines.push(`    // SEAM (typed json — unknown; narrow on canonical widen): ${f.camelName}`);
    }
    findViewLines.push(`    ${f.camelName}: row.${f.camelName},`);
  }
  for (const localFk of input.localFkColumns ?? []) {
    findViewLines.push(`    ${localFk.camelName}: row.${localFk.camelName},`);
  }
  if (input.hasTimestamps) {
    findViewLines.push(`    createdAt: row.createdAt,`);
    findViewLines.push(`    updatedAt: row.updatedAt,`);
  }
  const findViewBody = findViewLines.map((l) => `  ${l}`).join("\n");

  return `${SCAFFOLD_SENTINEL}
// Scaffolded once by @pattern-stack/codegen, then author-owned. Re-running codegen
// detects the sentinel above and SKIPS this file — your edits are safe.
//
// Default IIntegrationSink over the generated ${n.repoClass}. The PLUMBING
// (constructor, provider-match assert, repo delegation, userId scoping, return
// shapes) is generated. The write object is fully generated: scalar fields and
// type:json columns copy through as-is; FK external join-keys emit as active
// <rel>ExternalId: record.<rel>ExternalId copy-throughs (write member is string|null).
// Author seam: widen ${n.canonicalType} below when your canonical carries fields
// the projection does not (e.g. resolved FK external keys). See RFC-0004 / #489.
// Source: definitions entity '${input.entityName}' (surface: ${input.surface}).
import { Injectable } from '@nestjs/common';
import type { IIntegrationSink } from '${subsystemsImport(input.mode ?? "package", "integration")}';
import {
  ${n.repoClass},
  type ${n.projectionType},
  type ${n.writeType},
} from '${input.repoImportSpecifier}';

/** Canonical type the orchestrator diffs. Defaults to the generated projection;
 *  widen to your adapter's canonical shape if it carries fields the projection
 *  does not (e.g. external FK join-keys). */
export type ${n.canonicalType} = ${n.projectionType};

@Injectable()
export class ${n.sinkClass} implements IIntegrationSink<${n.canonicalType}> {
  constructor(
    private readonly repo: ${n.repoClass},
    private readonly provider: string,
  ) {}

  async findByExternalId(userId: string, externalId: string): Promise<${n.canonicalType} | null> {
    const row = await this.repo.findByExternalIdProjected(externalId, this.provider);
    if (row === null) return null;
    // The repo lookup is (provider, externalId)-scoped. If your external_id is not
    // globally unique, enforce ownership here (e.g. row.userId === userId).
    // Reshape the local projection into the canonical the orchestrator diffs.
    // Generated: BARE passthrough (preserves null so the differ converges) + json
    // at \`unknown\`. SEAM (author-owned, surfaced as a compile error on widen):
    // typed-json narrowing; null-coercion defaults (add on canonical widen);
    // external-key reconstruction; dropping local-only columns.
    // See file header (## Find-side reshaping) for the full seam description.
    const view: ${n.canonicalType} = {
${findViewBody}
    };
    return view;
  }

  async upsertByExternalId(
    userId: string,
    record: ${n.canonicalType},
    provider: string,
  ): Promise<{ id: string; saved: ${n.canonicalType} }> {
    if (provider !== this.provider) {
      throw new Error(\`${n.sinkClass}: bound provider '\${this.provider}' != run provider '\${provider}'\`);
    }
    const write: ${n.writeType} = {
${writeBody}
    };
    const proj = await this.repo.integrationUpsertOne(write, this.provider);
    return { id: proj.id, saved: record };
  }

  async softDeleteByExternalId(_userId: string, externalId: string): Promise<{ id: string } | null> {
    return this.repo.softDeleteByExternalId(externalId, this.provider);
  }
}
`;
}
