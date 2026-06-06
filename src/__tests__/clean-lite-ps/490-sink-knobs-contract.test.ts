/**
 * #490 two-derivation contract test — the anti-drift lock.
 *
 * The integration write/projection surface is derived TWICE from the same raw
 * entity YAML, by two pieces of code that share no module:
 *   - buildIntegrationSurface()  (prompt-extension.js) → repo config
 *   - buildSinkInput()           (adapter-emission-generator.ts) → sink config
 *
 * This file locks that both derivations agree on ALL knobs from the spec
 * (Gate 2.5 corrected mechanism):
 *
 *   (a) exclude_fields: both derivations drop the SAME field from the WRITE
 *       surface (writeColumns / copyThroughFields). NOT from the find view.
 *   (b) The excluded field remains in projectionColumns/projectionFields
 *       (exclusion is write-surface only — the projection type is untouched).
 *   (c) #488's find VIEW KEEPS the excluded field as a bare passthrough
 *       (viewCopyThroughFields is unfiltered). Diff-soundness holds via the
 *       differ's `key in incoming` guard (deep-equal.differ.ts:159): the adapter
 *       never sources the excluded field → `incoming` lacks it → the
 *       existing-keys loop skips it → never compared, no spurious upsert.
 *   (d) resolveSoftDeleteBoolean and the sink deleteMode agree per the spec's
 *       mapping table (the delete-agreement lock) — validated against the REAL
 *       buildSinkInput output, not an inline re-implementation.
 *
 * Uses a MULTI-WORD excluded field (`conversation_external_id`) so a
 * snake/camel normalization bug cannot silently pass (#487 lesson — single-word
 * fields mask it).
 *
 * Gate 2.5 correction (2026-06-06): the original §(c) asserted the find VIEW
 * OMITS the excluded field (spec §Find-side drop-from-view). That was wrong:
 * the projection type retains the field, so omitting it from the view is a
 * compile error (`view: Canonical = {...}` missing a required member). The
 * corrected mechanism is write-surface-only exclusion + differ guard soundness.
 * §(c) is now inverted: view KEEPS the field.
 */

import { describe, it, expect } from 'bun:test';
import {
  buildIntegrationSurface,
  resolveSoftDeleteBoolean,
} from '../../../templates/entity/new/clean-lite-ps/prompt-extension.js';
import {
  buildSinkInput,
} from '../../cli/shared/adapter-emission-generator';
import { generateDefaultSink } from '../../cli/shared/sink-emission-generator';

// ============================================================================
// Shared fixtures
// ============================================================================

/** processedFields for a message entity with conversation_external_id included
 *  (pre-filter; buildIntegrationSurface applies the exclude filter internally). */
const processedFields = [
  { name: 'body', camelName: 'body', tsType: 'string', nullable: false },
  // multi-word — critical for catching snake/camel normalization bugs
  {
    name: 'conversation_external_id',
    camelName: 'conversationExternalId',
    tsType: 'string',
    nullable: true,
  },
  { name: 'title', camelName: 'title', tsType: 'string', nullable: true },
];

const belongsTo: object[] = [];
const sinkPolicyExclude = { exclude_fields: ['conversation_external_id'] };

/** Entity definition shape consumed by buildSinkInput. */
const messageDef = {
  entity: {
    name: 'message',
    surface: 'messaging',
    pattern: 'Integrated',
    plural: 'messages',
  },
  fields: {
    body: { type: 'string' },
    conversation_external_id: { type: 'string', nullable: true },
    title: { type: 'string', nullable: true },
  },
  integration: {
    sink: {
      exclude_fields: ['conversation_external_id'],
    },
  },
};

/** Extract the defaultMessageToCanonicalView (or any entity's) view function body from
 *  the @generated base file. In the #491 two-file seam, the view lives in the standalone
 *  default function (not in findByExternalId — that method just calls this.toCanonicalView).
 *  Falls back to slicing from `async findByExternalId(` for backwards-compat with old callers.
 */
function findBody(out: string): string {
  // #491 Shape C: the view is in the standalone function `function default<E>ToCanonicalView`.
  const viewFnMarker = 'ToCanonicalView(';
  const fnStart = out.indexOf(viewFnMarker);
  if (fnStart !== -1) {
    // Find the function's closing `}\n` at top-level indentation.
    const bodyStart = out.indexOf('{', fnStart);
    // Walk from bodyStart to find the matching closing brace.
    let depth = 0;
    let i = bodyStart;
    while (i < out.length) {
      if (out[i] === '{') depth++;
      else if (out[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    return out.slice(bodyStart, i + 1);
  }
  // Legacy fallback: old single-file format used findByExternalId as the anchor.
  const start = out.indexOf('async findByExternalId(');
  const end = out.indexOf('\n  }\n', start);
  return out.slice(start, end + 4);
}

// ============================================================================
// (a) Both derivations drop the excluded field from the WRITE surface
// ============================================================================

describe('#490 contract (a): both derivations exclude conversationExternalId from write surface', () => {
  // Repo derivation via buildIntegrationSurface
  const surface = buildIntegrationSurface(
    'Integrated',
    processedFields,
    belongsTo,
    false,
    false,
    false,
    {},
    sinkPolicyExclude,
  ) as {
    integrationConfig: { writeColumns: string[] };
    writeFields: { camelName: string }[];
  };

  it('buildIntegrationSurface().integrationConfig.writeColumns excludes conversationExternalId', () => {
    expect(surface.integrationConfig.writeColumns).not.toContain('conversationExternalId');
  });

  it('buildIntegrationSurface().writeFields excludes conversationExternalId', () => {
    const names = surface.writeFields.map((f: { camelName: string }) => f.camelName);
    expect(names).not.toContain('conversationExternalId');
  });

  it('buildIntegrationSurface().writeColumns retains the non-excluded fields', () => {
    expect(surface.integrationConfig.writeColumns).toContain('body');
    expect(surface.integrationConfig.writeColumns).toContain('title');
  });

  // Sink derivation via the real buildSinkInput
  const sinkInput = buildSinkInput(
    messageDef as Parameters<typeof buildSinkInput>[0],
    'messaging',
    'slack',
    '../messaging/message.repository',
  );

  it('buildSinkInput().copyThroughFields excludes conversationExternalId (write surface)', () => {
    const names = sinkInput.copyThroughFields.map((f) => f.camelName);
    expect(names).not.toContain('conversationExternalId');
  });

  it('buildSinkInput().copyThroughFields retains the non-excluded fields', () => {
    const names = sinkInput.copyThroughFields.map((f) => f.camelName);
    expect(names).toContain('body');
    expect(names).toContain('title');
  });

  // Emitted write object (now in defaultMessageBuildWrite standalone function) must not
  // include the excluded field. #491: no more `const write: ...` in a single-method body;
  // the write body is inside the `defaultMessageBuildWrite` function in the @generated base.
  const sinkOut = generateDefaultSink(sinkInput); // shim → generateSinkBase

  it('emitted write function does not enumerate conversationExternalId', () => {
    // Extract defaultMessageBuildWrite function body (up to the next export function).
    const buildWriteStart = sinkOut.indexOf('export function defaultMessageBuildWrite(');
    const nextFn = sinkOut.indexOf('\nexport function', buildWriteStart + 1);
    const writeBlock = sinkOut.slice(buildWriteStart, nextFn === -1 ? undefined : nextFn);
    expect(writeBlock).not.toContain('conversationExternalId');
  });

  it('emitted write function enumerates the non-excluded fields (body, title)', () => {
    const buildWriteStart = sinkOut.indexOf('export function defaultMessageBuildWrite(');
    const nextFn = sinkOut.indexOf('\nexport function', buildWriteStart + 1);
    const writeBlock = sinkOut.slice(buildWriteStart, nextFn === -1 ? undefined : nextFn);
    expect(writeBlock).toContain('body: record.body,');
    expect(writeBlock).toContain('title: record.title,');
  });
});

// ============================================================================
// (b) Excluded field remains in projectionColumns/projectionFields
// ============================================================================

describe('#490 contract (b): excluded field stays in projectionColumns/projectionFields', () => {
  const surface = buildIntegrationSurface(
    'Integrated',
    processedFields,
    belongsTo,
    false,
    false,
    false,
    {},
    sinkPolicyExclude,
  ) as {
    integrationConfig: { projectionColumns: string[] };
    projectionFields: { camelName: string }[];
  };

  it('projectionColumns retains conversationExternalId (write-surface-only exclusion)', () => {
    expect(surface.integrationConfig.projectionColumns).toContain('conversationExternalId');
  });

  it('projectionFields retains conversationExternalId', () => {
    const names = surface.projectionFields.map((f: { camelName: string }) => f.camelName);
    expect(names).toContain('conversationExternalId');
  });

  it('projectionColumns also retains the non-excluded fields', () => {
    expect(surface.integrationConfig.projectionColumns).toContain('body');
    expect(surface.integrationConfig.projectionColumns).toContain('title');
  });
});

// ============================================================================
// (c) #488 find VIEW KEEPS the excluded field as a bare passthrough
//
// Gate 2.5 correction (2026-06-06): the find view uses viewCopyThroughFields
// (unfiltered). The excluded field stays in the view so the canonical type
// (= projection type, which retains the column) is satisfied. Diff-soundness
// holds via deep-equal.differ.ts:159 `key in incoming`: the adapter never
// sources the excluded field → incoming lacks it → never compared.
// ============================================================================

describe('#490 contract (c): find VIEW KEEPS excluded conversationExternalId as bare passthrough', () => {
  // Use the real buildSinkInput output — viewCopyThroughFields is unfiltered.
  const sinkInput = buildSinkInput(
    messageDef as Parameters<typeof buildSinkInput>[0],
    'messaging',
    'slack',
    '../messaging/message.repository',
  );

  it('buildSinkInput().viewCopyThroughFields includes conversationExternalId (unfiltered)', () => {
    const names = (sinkInput.viewCopyThroughFields ?? []).map((f) => f.camelName);
    expect(names).toContain('conversationExternalId');
  });

  const sinkOut = generateDefaultSink(sinkInput);

  it('find view ENUMERATES conversationExternalId: row.conversationExternalId (bare passthrough)', () => {
    expect(findBody(sinkOut)).toContain('conversationExternalId: row.conversationExternalId,');
  });

  it('find view also enumerates the non-excluded fields', () => {
    expect(findBody(sinkOut)).toContain('body: row.body,');
    expect(findBody(sinkOut)).toContain('title: row.title,');
  });

  it('find view has id and externalId (always present)', () => {
    expect(findBody(sinkOut)).toContain('id: row.id,');
    expect(findBody(sinkOut)).toContain('externalId: row.externalId,');
  });
});

// ============================================================================
// (d) resolveSoftDeleteBoolean and sink deleteMode mapping table
//
// Validated against the REAL buildSinkInput output (not inline re-implementation).
// ============================================================================

describe('#490 contract (d): resolveSoftDeleteBoolean + deleteMode agree', () => {
  // soft → softDelete: true + sink 'delegate'
  it("soft → resolveSoftDeleteBoolean true (regardless of hasSoftDelete)", () => {
    expect(resolveSoftDeleteBoolean('soft', false)).toBe(true);
    expect(resolveSoftDeleteBoolean('soft', true)).toBe(true);
  });

  it("soft → buildSinkInput().deleteMode is 'delegate'", () => {
    const input = buildSinkInput(
      { ...messageDef, integration: { sink: { delete: 'soft' } } } as Parameters<typeof buildSinkInput>[0],
      'messaging', 'slack', '../messaging/message.repository',
    );
    expect(input.deleteMode).toBe('delegate');
  });

  // tombstone → softDelete: false + sink 'delegate'
  it("tombstone → resolveSoftDeleteBoolean false (regardless of hasSoftDelete)", () => {
    expect(resolveSoftDeleteBoolean('tombstone', false)).toBe(false);
    expect(resolveSoftDeleteBoolean('tombstone', true)).toBe(false);
  });

  it("tombstone → buildSinkInput().deleteMode is 'delegate'", () => {
    const input = buildSinkInput(
      { ...messageDef, integration: { sink: { delete: 'tombstone' } } } as Parameters<typeof buildSinkInput>[0],
      'messaging', 'slack', '../messaging/message.repository',
    );
    expect(input.deleteMode).toBe('delegate');
  });

  // noop → softDelete: !!hasSoftDelete (unchanged) + sink 'noop'
  it("noop → resolveSoftDeleteBoolean returns !!hasSoftDelete (false)", () => {
    expect(resolveSoftDeleteBoolean('noop', false)).toBe(false);
  });

  it("noop → resolveSoftDeleteBoolean returns !!hasSoftDelete (true)", () => {
    expect(resolveSoftDeleteBoolean('noop', true)).toBe(true);
  });

  it("noop → buildSinkInput().deleteMode is 'noop'", () => {
    const input = buildSinkInput(
      { ...messageDef, integration: { sink: { delete: 'noop' } } } as Parameters<typeof buildSinkInput>[0],
      'messaging', 'slack', '../messaging/message.repository',
    );
    expect(input.deleteMode).toBe('noop');
  });

  // absent → softDelete: !!hasSoftDelete + sink 'delegate'
  it("absent → resolveSoftDeleteBoolean returns !!hasSoftDelete (false)", () => {
    expect(resolveSoftDeleteBoolean(undefined, false)).toBe(false);
  });

  it("absent → resolveSoftDeleteBoolean returns !!hasSoftDelete (true)", () => {
    expect(resolveSoftDeleteBoolean(undefined, true)).toBe(true);
  });

  it("absent → buildSinkInput().deleteMode is 'delegate'", () => {
    const input = buildSinkInput(
      { ...messageDef, integration: {} } as Parameters<typeof buildSinkInput>[0],
      'messaging', 'slack', '../messaging/message.repository',
    );
    expect(input.deleteMode).toBe('delegate');
  });

  // Noop emitter output: return null (no repo call)
  it("noop deleteMode → emitted softDeleteByExternalId returns null, no repo call", () => {
    const sinkInput = buildSinkInput(
      { ...messageDef, integration: { sink: { delete: 'noop' } } } as Parameters<typeof buildSinkInput>[0],
      'messaging', 'slack', '../messaging/message.repository',
    );
    const sinkOut = generateDefaultSink(sinkInput);
    const deleteBody = sinkOut.slice(
      sinkOut.indexOf('async softDeleteByExternalId('),
      sinkOut.indexOf('\n  }\n', sinkOut.indexOf('async softDeleteByExternalId(')),
    );
    expect(deleteBody).toContain('return null;');
    expect(deleteBody).not.toContain('repo.softDeleteByExternalId');
  });

  // Delegate emitter output: delegates to repo
  it("delegate deleteMode → emitted softDeleteByExternalId delegates to repo", () => {
    const sinkInput = buildSinkInput(
      { ...messageDef, integration: { sink: { delete: 'soft' } } } as Parameters<typeof buildSinkInput>[0],
      'messaging', 'slack', '../messaging/message.repository',
    );
    const sinkOut = generateDefaultSink(sinkInput);
    expect(sinkOut).toContain(
      'return this.repo.softDeleteByExternalId(externalId, this.provider);',
    );
  });
});

// ============================================================================
// buildIntegrationSurface: exclusion scope fence
// ============================================================================

describe('#490 buildIntegrationSurface: exclusion scope fence (write-only)', () => {
  const surface = buildIntegrationSurface(
    'Integrated',
    processedFields,
    belongsTo,
    true,   // hasTimestamps
    false,
    false,
    {},
    sinkPolicyExclude,
  ) as {
    integrationConfig: { writeColumns: string[]; projectionColumns: string[]; softDelete: boolean };
    writeFields: { camelName: string }[];
    projectionFields: { camelName: string }[];
  };

  it('writeColumns does not contain conversationExternalId (excluded from write)', () => {
    expect(surface.integrationConfig.writeColumns).not.toContain('conversationExternalId');
  });

  it('projectionColumns DOES contain conversationExternalId (not touched by exclusion)', () => {
    expect(surface.integrationConfig.projectionColumns).toContain('conversationExternalId');
  });

  it('projectionColumns DOES contain timestamps (hasTimestamps: true, unaffected)', () => {
    expect(surface.integrationConfig.projectionColumns).toContain('createdAt');
    expect(surface.integrationConfig.projectionColumns).toContain('updatedAt');
  });

  it('projectionFields DOES contain conversationExternalId', () => {
    const names = surface.projectionFields.map((f: { camelName: string }) => f.camelName);
    expect(names).toContain('conversationExternalId');
  });

  it('softDelete reflects hasSoftDelete default when delete knob absent', () => {
    expect(surface.integrationConfig.softDelete).toBe(false);
  });
});
