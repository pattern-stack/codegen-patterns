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
 * shapes. The `canonical ↔ local` FIELD MAPPING is the author seam — the
 * canonical type `T` is whatever the adapter's `IChangeSource.listChanges` body
 * yields. For FK-free entities the generated `<Entity>IntegrationProjection` IS
 * the canonical shape (passthrough, compiles with no edits); for entities with
 * external FK join-keys the scaffold leaves a marked author TODO.
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
 *  always `string | null`. The projection cannot supply it (it is the author
 *  seam), so the scaffold emits it as a commented `// TODO(author):` line. */
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
  //   - FK external join-keys — commented TODO(author) seam lines (the
  //     projection has no external key), kept commented so the object compiles.
  const hasUserIdField = input.copyThroughFields.some(
    (f) => f.camelName === USER_ID_FIELD,
  );
  const copyThroughLines = input.copyThroughFields
    .filter((f) => f.camelName !== USER_ID_FIELD)
    .map((f) => `      ${f.camelName}: record.${f.camelName},`);
  const fkTodoLines = input.fkExternalKeys.map(
    (fk) =>
      `      // ${fk.writeKey}: /* TODO(author): external id of the related ` +
      `${relationLabel(fk.writeKey)} */ null,`,
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
  if (fkTodoLines.length > 0) {
    writeBodyLines.push(
      `      // FK external join-keys — projection has no external key; supply from your canonical record:`,
      ...fkTodoLines,
    );
  }
  if (hasUserIdField) {
    // `userId` is sourced from the authenticated-user param, not the vendor
    // record — matches swe-brain's hand-authored sinks.
    writeBodyLines.push(`      userId,`);
  }
  const writeBody = writeBodyLines.join("\n");

  return `${SCAFFOLD_SENTINEL}
// Scaffolded once by @pattern-stack/codegen, then author-owned. Re-running codegen
// detects the sentinel above and SKIPS this file — your edits are safe.
//
// Default IIntegrationSink over the generated ${n.repoClass}. The PLUMBING
// (constructor, provider-match assert, repo delegation, userId scoping, return
// shapes) is generated. The canonical<->local FIELD MAPPING is the author seam:
// the canonical type is whatever your adapter's changeSource yields — the same
// seam as the IChangeSource.listChanges fetch body. For FK-free entities the
// generated ${n.projectionType} IS the canonical shape (passthrough);
// for entities with external FK join-keys, fill the marked TODO(s) below.
// Source: definitions entity '${input.entityName}' (surface: ${input.surface}).
import { Injectable } from '@nestjs/common';
import type { IIntegrationSink } from '@pattern-stack/codegen/subsystems';
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
    // The repo lookup is (provider, externalId)-scoped. If your external_id is not
    // globally unique, enforce ownership here (e.g. row.userId === userId).
    return row;
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

/** Derive a human label for a TODO comment from a write key. e.g.
 *  `accountExternalId` → `account`. Cosmetic only. */
function relationLabel(writeKey: string): string {
  const stripped = writeKey.replace(/ExternalId$/, "");
  return stripped || "related entity";
}
