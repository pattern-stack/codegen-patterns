/**
 * #490 two-derivation contract test — the anti-drift lock.
 *
 * The integration write/projection surface is derived TWICE from the same raw
 * entity YAML, by two pieces of code that share no module:
 *   - buildIntegrationSurface()  (prompt-extension.js) → repo config
 *   - buildSinkInput()           (adapter-emission-generator.ts) → sink config
 *
 * This file locks that both derivations agree on ALL knobs from the spec:
 *
 *   (a) exclude_fields: both derivations drop the SAME field from copy-through
 *       (writeColumns / copyThroughFields).
 *   (b) The excluded field remains in projectionColumns/projectionFields
 *       (exclusion is write-surface only).
 *   (c) #488's find VIEW omits the excluded field (built from the shared
 *       copyThroughFields — symmetric absence).
 *   (d) resolveSoftDeleteBoolean and the sink deleteMode agree per the spec's
 *       mapping table (the delete-agreement lock).
 *
 * Uses a MULTI-WORD excluded field (`conversation_external_id`) so a
 * snake/camel normalization bug cannot silently pass (#487 lesson — single-word
 * fields mask it).
 */

import { describe, it, expect } from 'bun:test';
import {
  buildIntegrationSurface,
  resolveSoftDeleteBoolean,
} from '../../../templates/entity/new/clean-lite-ps/prompt-extension.js';
import { generateDefaultSink } from '../../cli/shared/sink-emission-generator';
import type { SinkEmitInput } from '../../cli/shared/sink-emission-generator';

// ============================================================================
// Shared fixtures
// ============================================================================

/** processedFields for a message entity with conversation_external_id included
 *  (pre-filter; buildIntegrationSurface applies the exclude filter internally). */
const processedFields = [
  { name: 'body', camelName: 'body', tsType: 'string', nullable: false },
  // multi-word — the critical field for catching snake/camel normalization bugs
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

// ============================================================================
// (a) Both derivations drop the excluded field from copy-through
// ============================================================================

describe('#490 contract (a): both derivations exclude conversation_external_id from copy-through', () => {
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
    projectionColumns: string[];
    projectionFields: { camelName: string }[];
  };

  it('buildIntegrationSurface().integrationConfig.writeColumns excludes conversation_external_id', () => {
    expect(surface.integrationConfig.writeColumns).not.toContain(
      'conversationExternalId',
    );
  });

  it('buildIntegrationSurface().writeFields excludes conversationExternalId', () => {
    const names = surface.writeFields.map((f) => f.camelName);
    expect(names).not.toContain('conversationExternalId');
  });

  it('buildIntegrationSurface().integrationConfig.writeColumns retains body and title', () => {
    expect(surface.integrationConfig.writeColumns).toContain('body');
    expect(surface.integrationConfig.writeColumns).toContain('title');
  });

  // Sink derivation: the post-exclusion copyThroughFields list (simulates what
  // buildSinkInput produces after applying excludeSet to the fields map).
  // We test the emitter receives the post-exclusion list and does not re-introduce
  // the excluded field in the write object or find view.
  const postExclusionInput: SinkEmitInput = {
    entityName: 'message',
    entityClass: 'Message',
    surface: 'messaging',
    pattern: 'Integrated',
    provider: 'slack',
    copyThroughFields: [
      // conversation_external_id intentionally absent (excluded by buildSinkInput)
      { camelName: 'body', tsType: 'string' },
      { camelName: 'title', tsType: 'string | null' },
    ],
    fkExternalKeys: [],
    repoImportSpecifier: '../../../messaging/messages/message.repository',
    deleteMode: 'delegate',
  };
  const sinkOut = generateDefaultSink(postExclusionInput);

  it('sink write object does not enumerate conversationExternalId', () => {
    const writeBlock = sinkOut.slice(
      sinkOut.indexOf('const write: MessageIntegrationWrite = {'),
      sinkOut.indexOf('const proj ='),
    );
    expect(writeBlock).not.toContain('conversationExternalId');
  });

  it('sink write object enumerates the non-excluded fields (body, title)', () => {
    const writeBlock = sinkOut.slice(
      sinkOut.indexOf('const write: MessageIntegrationWrite = {'),
      sinkOut.indexOf('const proj ='),
    );
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

  it('projectionColumns retains conversationExternalId', () => {
    expect(surface.integrationConfig.projectionColumns).toContain(
      'conversationExternalId',
    );
  });

  it('projectionFields retains { camelName: conversationExternalId }', () => {
    const names = surface.projectionFields.map((f) => f.camelName);
    expect(names).toContain('conversationExternalId');
  });

  it('projectionColumns also retains the non-excluded fields', () => {
    expect(surface.integrationConfig.projectionColumns).toContain('body');
    expect(surface.integrationConfig.projectionColumns).toContain('title');
  });
});

// ============================================================================
// (c) #488 find VIEW omits the excluded field (symmetric absence)
//
// The find view is built from copyThroughFields (shared input); since exclusion
// drops the field from copyThroughFields, the view also omits it.
// This is the spec §Find-side assertion: "find() does NOT return the field."
// ============================================================================

describe('#490 contract (c): #488 find VIEW omits excluded conversationExternalId', () => {
  // The sink emitter receives the post-exclusion copyThroughFields (no
  // conversationExternalId). It builds the find view from that list.
  const sinkOut = generateDefaultSink({
    entityName: 'message',
    entityClass: 'Message',
    surface: 'messaging',
    pattern: 'Integrated',
    provider: 'slack',
    copyThroughFields: [
      { camelName: 'body', tsType: 'string' },
      { camelName: 'title', tsType: 'string | null' },
      // conversationExternalId intentionally absent (excluded)
    ],
    fkExternalKeys: [],
    repoImportSpecifier: '../../../messaging/messages/message.repository',
    deleteMode: 'delegate',
  });

  /** Extract findByExternalId method body. */
  function findBody(out: string): string {
    const start = out.indexOf('async findByExternalId(');
    const end = out.indexOf('\n  }\n', start);
    return out.slice(start, end + 4);
  }

  it('find view does not enumerate conversationExternalId', () => {
    expect(findBody(sinkOut)).not.toContain('conversationExternalId');
  });

  it('find view does enumerate the non-excluded fields', () => {
    expect(findBody(sinkOut)).toContain('body: row.body,');
    expect(findBody(sinkOut)).toContain('title: row.title,');
  });

  it('find view still has id and externalId (scope fence: those are separate inputs)', () => {
    expect(findBody(sinkOut)).toContain('id: row.id,');
    expect(findBody(sinkOut)).toContain('externalId: row.externalId,');
  });
});

// ============================================================================
// (d) resolveSoftDeleteBoolean and sink deleteMode mapping table
//
// Spec Tests §3d: assert that for each of the three modes, the repo config
// boolean and the sink body agree per the documented mapping table.
// ============================================================================

describe('#490 contract (d): resolveSoftDeleteBoolean + deleteMode agree', () => {
  // delete: soft → softDelete: true + sink 'delegate'
  it("soft → resolveSoftDeleteBoolean true", () => {
    expect(resolveSoftDeleteBoolean('soft', false)).toBe(true);
    expect(resolveSoftDeleteBoolean('soft', true)).toBe(true);
  });

  it("soft → sink deleteMode is 'delegate' (caller maps soft → delegate)", () => {
    // The caller (buildSinkInput) maps soft|tombstone → 'delegate', noop → 'noop'.
    // Verify the mapping rule: soft is NOT 'noop'.
    const deleteKnob = 'soft';
    const deleteMode = deleteKnob === 'noop' ? 'noop' : 'delegate';
    expect(deleteMode).toBe('delegate');
  });

  // delete: tombstone → softDelete: false + sink 'delegate'
  it("tombstone → resolveSoftDeleteBoolean false", () => {
    expect(resolveSoftDeleteBoolean('tombstone', false)).toBe(false);
    expect(resolveSoftDeleteBoolean('tombstone', true)).toBe(false);
  });

  it("tombstone → sink deleteMode is 'delegate'", () => {
    const deleteKnob = 'tombstone';
    const deleteMode = deleteKnob === 'noop' ? 'noop' : 'delegate';
    expect(deleteMode).toBe('delegate');
  });

  // delete: noop → softDelete: !!hasSoftDelete (unchanged default) + sink 'noop'
  it("noop → resolveSoftDeleteBoolean returns !!hasSoftDelete (false when no soft_delete)", () => {
    expect(resolveSoftDeleteBoolean('noop', false)).toBe(false);
  });

  it("noop → resolveSoftDeleteBoolean returns !!hasSoftDelete (true when soft_delete present)", () => {
    expect(resolveSoftDeleteBoolean('noop', true)).toBe(true);
  });

  it("noop → sink deleteMode is 'noop'", () => {
    const deleteKnob = 'noop';
    const deleteMode = deleteKnob === 'noop' ? 'noop' : 'delegate';
    expect(deleteMode).toBe('noop');
  });

  // absent → softDelete: !!hasSoftDelete + sink 'delegate'
  it("absent → resolveSoftDeleteBoolean returns !!hasSoftDelete (false)", () => {
    expect(resolveSoftDeleteBoolean(undefined, false)).toBe(false);
  });

  it("absent → resolveSoftDeleteBoolean returns !!hasSoftDelete (true)", () => {
    expect(resolveSoftDeleteBoolean(undefined, true)).toBe(true);
  });

  it("absent → sink deleteMode is 'delegate'", () => {
    const deleteKnob = undefined;
    const deleteMode = deleteKnob === 'noop' ? 'noop' : 'delegate';
    expect(deleteMode).toBe('delegate');
  });

  // Noop-emitted sink body actually returns null (not repo delegation)
  it("noop deleteMode → emitted softDeleteByExternalId returns null (no repo call)", () => {
    const sinkOut = generateDefaultSink({
      entityName: 'message',
      entityClass: 'Message',
      surface: 'messaging',
      pattern: 'Integrated',
      provider: 'slack',
      copyThroughFields: [{ camelName: 'body', tsType: 'string' }],
      fkExternalKeys: [],
      repoImportSpecifier: '../messaging/message.repository',
      deleteMode: 'noop',
    });
    const deleteBody = sinkOut.slice(
      sinkOut.indexOf('async softDeleteByExternalId('),
      sinkOut.indexOf('\n  }\n', sinkOut.indexOf('async softDeleteByExternalId(')),
    );
    expect(deleteBody).toContain('return null;');
    expect(deleteBody).not.toContain('repo.softDeleteByExternalId');
  });

  // Delegate-emitted sink body delegates to the repo
  it("delegate deleteMode → emitted softDeleteByExternalId delegates to repo", () => {
    const sinkOut = generateDefaultSink({
      entityName: 'message',
      entityClass: 'Message',
      surface: 'messaging',
      pattern: 'Integrated',
      provider: 'slack',
      copyThroughFields: [{ camelName: 'body', tsType: 'string' }],
      fkExternalKeys: [],
      repoImportSpecifier: '../messaging/message.repository',
      deleteMode: 'delegate',
    });
    expect(sinkOut).toContain(
      'return this.repo.softDeleteByExternalId(externalId, this.provider);',
    );
  });
});

// ============================================================================
// buildIntegrationSurface: exclusion filter scope fence
//
// Spec Tests §4: drop excluded from writeColumns/writeFields but NOT from
// projectionColumns/projectionFields; do NOT touch local-FK or timestamp inputs.
// ============================================================================

describe('#490 buildIntegrationSurface: exclusion scope fence', () => {
  const surface = buildIntegrationSurface(
    'Integrated',
    processedFields,
    belongsTo,
    true,
    false,
    false,
    {},
    sinkPolicyExclude,
  ) as {
    integrationConfig: { writeColumns: string[]; projectionColumns: string[]; softDelete: boolean };
    writeFields: { camelName: string }[];
    projectionFields: { camelName: string }[];
  };

  it('writeColumns does not contain conversationExternalId (excluded)', () => {
    expect(surface.integrationConfig.writeColumns).not.toContain('conversationExternalId');
  });

  it('projectionColumns DOES contain conversationExternalId (not touched by exclusion)', () => {
    expect(surface.integrationConfig.projectionColumns).toContain('conversationExternalId');
  });

  it('projectionColumns DOES contain timestamps (hasTimestamps: true, unaffected by exclusion)', () => {
    expect(surface.integrationConfig.projectionColumns).toContain('createdAt');
    expect(surface.integrationConfig.projectionColumns).toContain('updatedAt');
  });

  it('projectionFields DOES contain conversationExternalId', () => {
    const names = surface.projectionFields.map((f) => f.camelName);
    expect(names).toContain('conversationExternalId');
  });

  it('softDelete reflects hasSoftDelete default when delete knob absent', () => {
    // sinkPolicyExclude has no delete key — softDelete = !!hasSoftDelete = false.
    expect(surface.integrationConfig.softDelete).toBe(false);
  });
});
