/**
 * Default `IIntegrationSink` emitter — TWO-FILE SEAM (#491, RFC-0002 §4, Track D · E1).
 *
 * ## Two-file seam design (Shape C — tsc-verified, TS 6.0.3 --strict, probe_BConly.ts)
 *
 * Per (surface, entity-with-`surface:` + `pattern: Integrated`), emits:
 *   1. **`<entity>.sink.generated.ts`** — `@generated` (regenerated via `writeIfChanged`).
 *      Carries two STANDALONE DEFAULT FUNCTIONS at CONCRETE projection/write types
 *      (`default<E>BuildWrite` / `default<E>ToCanonicalView`) and an abstract base class
 *      (`<Entity>SinkBase<TCanonical = <E>IntegrationProjection>`) with three CONCRETE
 *      protocol methods and two ABSTRACT seams. A YAML field change reflows the mapping
 *      here on every run — the central acceptance gain over emit-once.
 *   2. **`<entity>.sink.ts`** — emit-once (`existsSync`-skip), the author subclass
 *      `class <Entity>Sink extends <Entity>SinkBase` with the two one-line seam wirings.
 *      Regen never touches it; author overrides survive. Keeps the class name +
 *      import path the assembly binding already uses.
 *
 * ## Why Shape C (the generic/cast trilemma — RESOLVED)
 *
 * The probe (`/tmp/sink-trilemma/probe_BConly.ts`, TS 6.0.3 --strict, exit 0) proved:
 *   - Shape A FAILS — a generic base with a default-bodied seam typed `TCanonical` is
 *     TS2322: the literal `{…projection…}` is not assignable to `TCanonical` when
 *     the subclass widens it to an unrelated canonical type.
 *   - Shape C COMPILES CAST-FREE — abstract seams on the base (no body → no TS2322),
 *     the mechanical default bodies in STANDALONE FUNCTIONS at the CONCRETE types
 *     (literal IS the return type, no cast), and the projection-default subclass
 *     wires the defaults in one line each.
 *
 * ## The four author seams and how each survives regen
 *
 * | # | Seam | Survives regen because… |
 * |---|---|---|
 * | 1 | Canonical widening | type-arg lives in the emit-once subclass (`extends <E>SinkBase<YourCanonical>`) |
 * | 2 | FK activation | override `buildWrite` in the subclass, replacing the default wiring |
 * | 3 | Typed-json narrowing | override `toCanonicalView` in the subclass |
 * | 4 | Null-coercion on widen | same `toCanonicalView` override; TS forces the choice |
 *
 * ## `write` object (SEAM #2)
 *
 * Built by explicit field enumeration so it type-checks against `<Entity>IntegrationWrite`
 * with no spread/cast:
 *   - `externalId` — always present.
 *   - copy-through fields (`copyThroughFields` — post-exclusion), one `<f>: record.<f>` each,
 *     EXCEPT `userId` (sourced from the method param — bare `userId,` shorthand).
 *   - FK external join-keys — emitted as `<writeKey>: null` + SEAM comment. The
 *     projection-default canonical has no external-key member; null is write-safe (the
 *     repo's `!== null` guard skips it, `integrated-entity-repository.ts:118-120`). Replace
 *     `null` with `record.<writeKey>` in a subclass `buildWrite` override after widening.
 *
 * ## Find-side reshaping (SEAM #3/#4) — #488
 *
 * `default<E>ToCanonicalView` returns an EXPLICIT projection → canonical view. Every field
 * is a BARE passthrough (`<f>: row.<f>`) — no `??` coercion and no `as` cast:
 *   - Bare passthrough PRESERVES `null` so the orchestrator's `DeepEqualDiffer` converges
 *     to noop (`null ≠ ''`; a `?? ''` coercion would make a legitimately-null column diff
 *     false → spurious upsert; `deep-equal.differ.ts:187-208`).
 *   - `type: json` columns pass through at `unknown` — a typed cast is the SEAM #3
 *     author override (`toCanonicalView` in the subclass, surfaced as a compile error on widen).
 *   - Find view uses `viewCopyThroughFields` (FULL projection incl. excluded fields) per
 *     #490 Gate 2.5: exclusion is write-surface-only. The view is knob-independent.
 *
 * AUTHOR SEAM (override `toCanonicalView` in the subclass):
 *   - Typed-json narrowing (`unknown → MyType[]`) — no cast-free generator solution.
 *   - ALL null-coercion defaults — added only when a member is widened to non-null.
 *   - External-key reconstruction on the find side (a local `accountId` ≠ `accountExternalId`).
 *   - Dropping local-only projection columns when you widen the canonical.
 *
 * ## `userId` is NOT injected — it is a declared field
 *
 * If the entity declares a `user_id` field, `userId` is sourced from the method parameter
 * (the authenticated user), emitted as a bare `userId,` shorthand — matching swe-brain's
 * hand-authored sinks. If NOT declared, the write object omits `userId` entirely.
 *
 * ## @Injectable() — OMITTED (OQ2 CLOSED, #491)
 *
 * The assembly binds the sink via `useFactory: (repo) => new <E>Sink(repo, '<provider>')`
 * (`assembly-emission-generator.ts:204-206`). NestJS never class-token-instantiates the sink;
 * the decorator is dead under a `useFactory`. Omitted to keep the generated base lean.
 */

import { subsystemsImport, type RuntimeMode } from "./runtime-import";

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
 *  always `string | null`. Emitted as `<writeKey>: null` in the base default
 *  function; the author overrides `buildWrite` in the subclass to activate it
 *  after widening `<Entity>Canonical` (RFC-0004 / #489 track canonical ownership). */
export interface SinkFkExternalKey {
  /** Write-surface key name, e.g. `accountExternalId`. */
  writeKey: string;
}

/** Pure input for {@link generateSinkBase} / {@link generateSinkSubclass}.
 *  The caller (E2) derives this from the entity definition + locations config;
 *  nothing here is path-computed inside the emitter. */
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
  /** Copy-through scalar columns for the WRITE OBJECT — the entity's `fields:`
   *  block with FK columns AND any `integration.sink.exclude_fields` entries
   *  removed, exactly as the repo template's `writeFields` after #490 exclusion.
   *  Excluded fields are absent here (no-clobber: the repo never writes them on
   *  upsert) but ARE still present in `viewCopyThroughFields` (the find view
   *  enumerates the full projection so the canonical type-checks). */
  copyThroughFields: SinkCopyThroughField[];
  /** Copy-through scalar columns for the FIND VIEW — the entity's `fields:` block
   *  with FK columns excluded but `integration.sink.exclude_fields` entries kept.
   *  Enumerated as bare passthroughs in `default<E>ToCanonicalView` so the view
   *  satisfies the projection-default canonical (TS requires all members; excluded
   *  fields stay in the projection type). Diff-soundness: the adapter never sources
   *  excluded fields → `incoming` lacks them → the differ's `key in incoming`
   *  guard (`deep-equal.differ.ts:159`) drops them from candidates before
   *  comparison — never compared, no spurious upsert.
   *
   *  When omitted (callers that predate #490 or pass only `copyThroughFields`),
   *  falls back to `copyThroughFields` for backward-compat (no regression for
   *  entities without `exclude_fields`). */
  viewCopyThroughFields?: SinkCopyThroughField[];
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
  /**
   * Resolved delete behavior for the sink BODY (#490).
   *
   * - `'delegate'` — default; emit `return this.repo.softDeleteByExternalId(...)`.
   *   Both `soft` and `tombstone` YAML knob values map here (the distinction is
   *   the REPO config boolean — `softDelete: true/false` — not the sink body).
   * - `'noop'` — emit a silent `return null;` body with a doc comment. The
   *   sink short-circuits; the repo is never called for the delete path.
   *
   * Absent knob defaults to `'delegate'` (preserves today's exact behavior).
   *
   * Default: `'delegate'` when omitted.
   */
  deleteMode?: 'delegate' | 'noop';
}

// ============================================================================
// Names
// ============================================================================

interface SinkNames {
  sinkClass: string;       // ContactSink
  sinkBaseClass: string;   // ContactSinkBase
  repoClass: string;       // ContactRepository
  projectionType: string;  // ContactIntegrationProjection
  writeType: string;       // ContactIntegrationWrite
  defaultBuildWrite: string;      // defaultContactBuildWrite
  defaultToCanonicalView: string; // defaultContactToCanonicalView
}

function sinkNames(entityClass: string): SinkNames {
  return {
    sinkClass: `${entityClass}Sink`,
    sinkBaseClass: `${entityClass}SinkBase`,
    repoClass: `${entityClass}Repository`,
    projectionType: `${entityClass}IntegrationProjection`,
    writeType: `${entityClass}IntegrationWrite`,
    defaultBuildWrite: `default${entityClass}BuildWrite`,
    defaultToCanonicalView: `default${entityClass}ToCanonicalView`,
  };
}

// ============================================================================
// Shared validation
// ============================================================================

function assertIntegrated(input: SinkEmitInput): void {
  if (input.pattern !== "Integrated") {
    throw new Error(
      `cannot emit default integration sink for entity '${input.entityName}': ` +
        `it is 'pattern: ${input.pattern}', but the default sink is emittable ` +
        `only for 'pattern: Integrated' entities (the only family with the ` +
        `integrationUpsertOne / findByExternalIdProjected projection path). ` +
        `Add 'pattern: Integrated' to the entity or provide a hand-authored sink.`,
    );
  }
}

// ============================================================================
// Shared body builders (reused by both emitters)
// ============================================================================

function buildWriteBodyLines(input: SinkEmitInput, n: SinkNames): string[] {
  const hasUserIdField = input.copyThroughFields.some(
    (f) => f.camelName === USER_ID_FIELD,
  );
  const copyThroughLines = input.copyThroughFields
    .filter((f) => f.camelName !== USER_ID_FIELD)
    .map((f) => `      ${f.camelName}: record.${f.camelName},`);
  const fkLines = input.fkExternalKeys.flatMap((fk) => [
    `      // SEAM (FK external key — null until you widen ${n.projectionType} to carry \`${fk.writeKey}\`):`,
    `      // Replace null with record.${fk.writeKey} after widening. Write-safe: repo skips null FKs.`,
    `      ${fk.writeKey}: null,`,
  ]);

  const lines: string[] = [
    `      externalId: record.externalId,`,
  ];
  if (copyThroughLines.length > 0) {
    lines.push(
      `      // copy-through fields (one line per \`fields:\` entry):`,
      ...copyThroughLines,
    );
  }
  if (fkLines.length > 0) {
    lines.push(
      `      // FK external join-keys (null until canonical widens to carry them):`,
      ...fkLines,
    );
  }
  if (hasUserIdField) {
    // `userId` is sourced from the authenticated-user param, not the vendor
    // record — matches swe-brain's hand-authored sinks.
    lines.push(`      userId,`);
  }
  return lines;
}

function buildFindViewLines(input: SinkEmitInput): string[] {
  // Exclusion (#490): viewCopyThroughFields is the FULL projection copy-through
  // list (no exclude_fields filter). Excluded fields stay in the view as bare
  // passthroughs — the projection type requires them. Diff-soundness holds via
  // deep-equal.differ.ts:159 `key in incoming`. Falls back to copyThroughFields
  // when viewCopyThroughFields is absent (pre-#490 callers).
  const viewFields = input.viewCopyThroughFields ?? input.copyThroughFields;
  const lines: string[] = [
    `    id: row.id,`,
    `    externalId: row.externalId,`,
  ];
  for (const f of viewFields) {
    const isJson = f.tsType.startsWith("unknown");
    if (isJson) {
      // SEAM (typed json): `unknown` passes through; typed-narrowing is author-owned.
      // When you widen the canonical to a concrete type (e.g. MyType[]), this line
      // becomes a compile error — that is intentional: no cast-free generator
      // solution exists; you supply the typed narrowing (or a safe runtime guard).
      lines.push(`    // SEAM (typed json — unknown; narrow on canonical widen): ${f.camelName}`);
    }
    lines.push(`    ${f.camelName}: row.${f.camelName},`);
  }
  for (const localFk of input.localFkColumns ?? []) {
    lines.push(`    ${localFk.camelName}: row.${localFk.camelName},`);
  }
  if (input.hasTimestamps) {
    lines.push(`    createdAt: row.createdAt,`);
    lines.push(`    updatedAt: row.updatedAt,`);
  }
  return lines;
}

function buildDeleteBody(input: SinkEmitInput): string {
  // softDeleteByExternalId body (#490 delete knob):
  //   'delegate' (default) → repo delegation (unchanged behavior).
  //   'noop'              → silent return null; + comment explains intent.
  if ((input.deleteMode ?? "delegate") === "noop") {
    return [
      `// delete:noop (YAML integration.sink.delete: noop) — tombstone-preserving:`,
      `// an upstream delete signal is a no-op here; the repo row is left intact.`,
      `// Returns null → the orchestrator records an audit noop. Override this`,
      `// method in the subclass if you need a log line.`,
      `return null;`,
    ].join("\n    ");
  }
  return `return this.repo.softDeleteByExternalId(externalId, this.provider);`;
}

// ============================================================================
// Emitters
// ============================================================================

/**
 * Emit the `@generated` base file (`<entity>.sink.generated.ts`) — Shape C
 * (probe-proven, cast-free under TS 6.0.3 `--strict`).
 *
 * Three parts:
 *   1. Standalone `default<E>BuildWrite` / `default<E>ToCanonicalView` functions
 *      at CONCRETE projection/write types — the regenerated home of the #487 write
 *      body and #488 find view. A YAML field change reflows here on every run.
 *   2. `abstract class <Entity>SinkBase<TCanonical = <Entity>IntegrationProjection>
 *      implements IIntegrationSink<TCanonical>` — three CONCRETE methods (provider
 *      assert, repo delegation, #490 knob-driven delete), two `protected abstract`
 *      seams (`buildWrite` / `toCanonicalView`). No `@Injectable()` (OQ2 CLOSED).
 *      No `extends` bound (an `extends <E>IntegrationProjection` bound rejects a
 *      widened canonical that drops a projection column).
 *
 * Callers: `emitAdapters` in `adapter-emission-generator.ts` (always regenerates
 * via `writeIfChanged` — no existsSync gate on the base file).
 */
export function generateSinkBase(input: SinkEmitInput): string {
  assertIntegrated(input);

  const n = sinkNames(input.entityClass);
  const writeBodyLines = buildWriteBodyLines(input, n);
  const writeBody = writeBodyLines.join("\n");

  const findViewLines = buildFindViewLines(input);
  const findViewBody = findViewLines.map((l) => `  ${l}`).join("\n");

  const deleteBody = buildDeleteBody(input);

  const banner =
    `// @generated by @pattern-stack/codegen from definitions entity '${input.entityName}' ` +
    `(surface: ${input.surface}) — DO NOT EDIT.\n` +
    `// Hand edits are overwritten on re-emit. Regenerate with \`bun run codegen\`.\n` +
    `//\n` +
    `// Two-file seam (Shape C, #491, RFC-0002 §4):\n` +
    `//   THIS FILE  — @generated base: two standalone default functions at concrete types\n` +
    `//                + abstract class ${n.sinkBaseClass}<TCanonical>.\n` +
    `//                A YAML field change reflows the mapping here on every run.\n` +
    `//   ${input.entityName}.sink.ts — emit-once subclass: \`class ${n.sinkClass} extends ${n.sinkBaseClass}\`\n` +
    `//                with the two one-line seam wirings. Author overrides survive regen.\n` +
    `//\n` +
    `// SEAM #1 (canonical widening): change \`extends ${n.sinkBaseClass}\` →\n` +
    `//   \`extends ${n.sinkBaseClass}<YourCanonical>\` in the subclass.\n` +
    `// SEAM #2 (FK activation): override \`buildWrite\` in the subclass.\n` +
    `//   Replace \`${n.defaultBuildWrite}(record)\` with your body that sets\n` +
    `//   \`<writeKey>: record.<writeKey>\` after widening the canonical to carry it.\n` +
    `// SEAM #3/#4 (typed-json narrow / null-coerce on widen): override \`toCanonicalView\`.\n` +
    `//   The bare passthrough preserves null (diff-soundness); coerce only on canonical widen.`;

  return `${banner}
import type { IIntegrationSink } from '${subsystemsImport(input.mode ?? "package", "integration")}';
import {
  ${n.repoClass},
  type ${n.projectionType},
  type ${n.writeType},
} from '${input.repoImportSpecifier}';

// Standalone default functions at CONCRETE projection/write types — the literal IS the
// return type, so NO cast is needed (this is what dodges the TS2322 of a generic default
// body). The regenerated home of the #487 write body and #488 find view.
// Override these in the emit-once subclass via buildWrite / toCanonicalView.
export function ${n.defaultBuildWrite}(record: ${n.projectionType}): ${n.writeType} {
  return {
${writeBody}
  };
}

export function ${n.defaultToCanonicalView}(row: ${n.projectionType}): ${n.projectionType} {
  // BARE passthrough — preserves null so the orchestrator's DeepEqualDiffer converges
  // to noop (null ≠ ''; deep-equal.differ.ts:187-208). The projection-default canonical
  // is exactly the projection shape, so bare passthrough type-checks without a cast.
  const view: ${n.projectionType} = {
${findViewBody}
  };
  return view;
}

// Abstract base — the three IIntegrationSink methods are CONCRETE (machinery: provider
// assert, repo delegation, #490 knob-driven delete). The two protected abstract seams are
// typed at TCanonical with NO body — a default body returning TCanonical would be TS2322
// (the probe proved this: /tmp/sink-trilemma/probe_BConly.ts, Shape A failure). The bodies
// live in the standalone functions above; the emit-once subclass wires them in one line each.
// No @Injectable() — the assembly binds via useFactory (OQ2 CLOSED, #491).
export abstract class ${n.sinkBaseClass}<TCanonical = ${n.projectionType}>
  implements IIntegrationSink<TCanonical> {
  constructor(
    protected readonly repo: ${n.repoClass},
    protected readonly provider: string,
  ) {}

  async findByExternalId(userId: string, externalId: string): Promise<TCanonical | null> {
    const row = await this.repo.findByExternalIdProjected(externalId, this.provider);
    if (row === null) return null;
    // The repo lookup is (provider, externalId)-scoped. If your external_id is not
    // globally unique, enforce ownership here (e.g. row.userId === userId).
    return this.toCanonicalView(row);
  }

  async upsertByExternalId(
    userId: string,
    record: TCanonical,
    provider: string,
  ): Promise<{ id: string; saved: TCanonical }> {
    if (provider !== this.provider) {
      throw new Error(\`${n.sinkClass}: bound provider '\${this.provider}' != run provider '\${provider}'\`);
    }
    const proj = await this.repo.integrationUpsertOne(this.buildWrite(record), this.provider);
    return { id: proj.id, saved: record };
  }

  async softDeleteByExternalId(_userId: string, externalId: string): Promise<{ id: string } | null> {
    ${deleteBody}
  }

  // ABSTRACT seams (NO body — a default body returning TCanonical is TS2322).
  // The projection-default subclass wires the default functions; a widened
  // subclass reimplements them (FK activation / typed-json narrow / null-coerce).
  protected abstract toCanonicalView(row: ${n.projectionType}): TCanonical;
  protected abstract buildWrite(record: TCanonical): ${n.writeType};
}
`;
}

/**
 * Emit the emit-once subclass file (`<entity>.sink.ts`) — `class <Entity>Sink
 * extends <Entity>SinkBase` with the two one-line seam wirings.
 *
 * NOT an empty body — the seams are `abstract` on the base, so the subclass
 * MUST implement them. The two wirings call the standalone default functions
 * from the `@generated` base file — the mapping reflows there on every run.
 *
 * `existsSync`-skipped by the caller (`emitAdapters`): regen never overwrites
 * this file after the first emit. Author overrides in this file survive regen.
 *
 * How to widen (all four seams):
 *   1. `extends ${EntityName}SinkBase<YourCanonical>` — binds the type param.
 *   2. Override `toCanonicalView` — reshape the projection, narrow json, coerce nulls.
 *   3. Override `buildWrite` — activate FK write keys, pass from your canonical.
 *   4. If needed, override `softDeleteByExternalId` for a log line (the base handles
 *      the delegate/noop knob — override only for extra side effects).
 *
 * You MAY call `default<E>BuildWrite(record)` inside `buildWrite` and spread-then-
 * override a single key — the standalone function is importable for exactly this use.
 */
export function generateSinkSubclass(input: SinkEmitInput): string {
  assertIntegrated(input);

  const n = sinkNames(input.entityClass);

  return `// Emit-once — author-owned. Regen never overwrites this file.
// The mechanical mapping lives in ${input.entityName}.sink.generated.ts and reflows on every
// codegen run (a YAML field change reflows into the @generated base + default functions).
//
// To WIDEN (all four seams — see ${input.entityName}.sink.generated.ts banner for detail):
//   1. Change \`extends ${n.sinkBaseClass}\` → \`extends ${n.sinkBaseClass}<YourCanonical>\`.
//   2. Override \`toCanonicalView\`: reshape projection, narrow typed json, coerce nulls.
//   3. Override \`buildWrite\`: activate FK write keys (\`<writeKey>: record.<writeKey>\`).
//   4. Optionally override \`softDeleteByExternalId\` if you want a log line.
//      (The base handles delegate/noop via the #490 YAML knob — no override needed otherwise.)
// Source: definitions entity '${input.entityName}' (surface: ${input.surface}).
import {
  ${n.sinkBaseClass},
  ${n.defaultToCanonicalView},
  ${n.defaultBuildWrite},
} from './${input.entityName}.sink.generated';
import type {
  ${n.projectionType},
  ${n.writeType},
} from '${input.repoImportSpecifier}';

export class ${n.sinkClass} extends ${n.sinkBaseClass} {
  protected toCanonicalView(row: ${n.projectionType}): ${n.projectionType} {
    return ${n.defaultToCanonicalView}(row);
  }

  protected buildWrite(record: ${n.projectionType}): ${n.writeType} {
    return ${n.defaultBuildWrite}(record);
  }
}
`;
}

// ============================================================================
// Legacy export — kept for any call-site that hasn't migrated to the two-file
// split yet. Delegates to generateSinkBase (the plumbing is identical; the
// subclass is a separate call). This is NOT the canonical path — use
// generateSinkBase + generateSinkSubclass via emitAdapters.
// ============================================================================

/**
 * @deprecated Use {@link generateSinkBase} + {@link generateSinkSubclass} instead.
 *   This shim returns only the base file text for legacy call-sites in tests
 *   that import `generateDefaultSink` by name. It will be removed once all
 *   call-sites migrate to the two-function API.
 */
export function generateDefaultSink(input: SinkEmitInput): string {
  return generateSinkBase(input);
}
