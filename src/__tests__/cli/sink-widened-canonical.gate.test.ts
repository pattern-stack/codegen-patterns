/**
 * §3b — Widened-canonical compile gate (#491, Shape C).
 *
 * Proves that the ACTUALLY-EMITTED base file (not the probe's hand-mirrored version)
 * accepts a widened subclass with zero casts outside the typed-json seam.
 *
 * The probe at /tmp/sink-trilemma/probe_BConly.ts proved Shape C compiles in isolation
 * under TS 6.0.3 --strict. This gate promotes that proof to CI against the REAL emitter
 * output: we call generateSinkBase() to get the actual emitted base string, write it + a
 * hand-written widened subclass to a temp dir, and run `tsc --noEmit` on both.
 *
 * Two subclass shapes exercised:
 *   A. Projection-default (non-widened) — mirrors the emit-once subclass codegen emits.
 *      Zero casts.
 *   B. Widened canonical — author drops a projection member, overrides both seams.
 *      Zero casts on scalar members; one author-owned `as` on the typed-json seam.
 *
 * The message fixture is used because it has:
 *   - body: string (non-null scalar — exercises bare copy-through)
 *   - reactions: unknown (json — exercises the SEAM #3 typed-json seam, cast allowed here)
 *   - conversationExternalId: string | null (excluded from write — absent from write type,
 *     present in view — exercises #490 write-surface-only exclusion)
 *   - createdAt / updatedAt (timestamps)
 *
 * If this test fails with a tsc error, the emitted base does NOT accept a widened canonical
 * cast-free — that is a regression in the Shape C implementation.
 */

import { describe, it, expect } from 'bun:test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateSinkBase } from '../../cli/shared/sink-emission-generator';

// ============================================================================
// §3b fixture input — message entity (json + exclude_fields + timestamps)
// ============================================================================

const MESSAGE_SINK_INPUT = {
  entityName: 'message',
  entityClass: 'Message',
  surface: 'crm',
  pattern: 'Integrated',
  provider: 'salesforce',
  copyThroughFields: [
    // body: non-null string — bare copy-through in write
    { camelName: 'body', tsType: 'string' },
    // reactions omitted: json fields are excluded from the write surface.
    // They appear only in viewCopyThroughFields (the projection keeps them).
  ],
  // viewCopyThroughFields: FULL projection copy-through — includes fields excluded
  // from write. reactions (json/unknown) is write-excluded but view-included per #490.
  // conversationExternalId is write-excluded (integration.sink.exclude_fields) but view-included.
  viewCopyThroughFields: [
    { camelName: 'body', tsType: 'string' },
    { camelName: 'reactions', tsType: 'unknown' },
    { camelName: 'conversationExternalId', tsType: 'string | null' },
  ],
  fkExternalKeys: [],
  repoImportSpecifier: './message.stub.repository',
  hasTimestamps: true,
  deleteMode: 'noop' as const,
};

// ============================================================================
// Stub types — the repo module (MessageRepository + projection + write types)
// We emit these as a stub file so the temp tsc has the concrete types to check against.
// ============================================================================

const STUB_REPO_TS = `
export interface MessageIntegrationProjection {
  id: string;
  externalId: string;
  body: string;
  reactions: unknown;
  conversationExternalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface MessageIntegrationWrite {
  externalId: string;
  body: string;
  // conversationExternalId is excluded from write surface (#490)
}
export class MessageRepository {
  async findByExternalIdProjected(_externalId: string, _provider: string): Promise<MessageIntegrationProjection | null> {
    return null as unknown as MessageIntegrationProjection | null;
  }
  async integrationUpsertOne(_write: MessageIntegrationWrite, _provider: string): Promise<MessageIntegrationProjection> {
    return null as unknown as MessageIntegrationProjection;
  }
  async softDeleteByExternalId(_externalId: string, _provider: string): Promise<{ id: string } | null> {
    return null;
  }
}
`;

// Minimal IIntegrationSink stub (the emitted base imports from @pattern-stack/codegen/subsystems).
// We stub it out with a tsconfig paths alias pointing to a local file.
const STUB_SINK_PROTOCOL_TS = `
export interface IIntegrationSink<TCanonical> {
  findByExternalId(userId: string, externalId: string): Promise<TCanonical | null>;
  upsertByExternalId(userId: string, record: TCanonical, provider: string): Promise<{ id: string; saved: TCanonical }>;
  softDeleteByExternalId(userId: string, externalId: string): Promise<{ id: string } | null>;
}
`;

// §3b Shape A (projection-default subclass) — mirrors what codegen emits.
// ZERO casts.
const WIDENED_SAMPLE_DEFAULT_TS = `
import {
  MessageSinkBase,
  defaultMessageToCanonicalView,
  defaultMessageBuildWrite,
} from './message.sink.generated';
import type { MessageIntegrationProjection, MessageIntegrationWrite } from './message.stub.repository';

export class MessageSinkDefault extends MessageSinkBase {
  protected toCanonicalView(row: MessageIntegrationProjection): MessageIntegrationProjection {
    return defaultMessageToCanonicalView(row);
  }
  protected buildWrite(record: MessageIntegrationProjection): MessageIntegrationWrite {
    return defaultMessageBuildWrite(record);
  }
}
`;

// §3b Shape B (widened canonical) — author-edited subclass.
// Exercises seam #1 (type-arg widening), seam #3 (typed-json narrow with one as), seam #4 (no ?? needed here).
// The widened canonical drops `conversationExternalId` — proves no `extends` bound.
const WIDENED_SAMPLE_TS = `
import { MessageSinkBase } from './message.sink.generated';
import type { MessageIntegrationProjection, MessageIntegrationWrite } from './message.stub.repository';

// WideMessage drops conversationExternalId (not in write, not needed by author).
// The unconstrained generic bound (<TCanonical = ...>, no 'extends') makes this legal.
interface WideMessage {
  id: string;
  externalId: string;
  body: string;
  reactions: string[];  // widened from unknown — typed-json seam #3
  createdAt: Date;
  updatedAt: Date;
}

// §3b: ZERO casts on scalars; one author-owned 'as' on the json seam only.
export class MessageSinkWidened extends MessageSinkBase<WideMessage> {
  protected toCanonicalView(row: MessageIntegrationProjection): WideMessage {
    return {
      id: row.id,
      externalId: row.externalId,
      body: row.body,                                  // string → string: no coerce
      reactions: (row.reactions ?? []) as string[],   // SEAM #3: one author-owned 'as' for typed json
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      // conversationExternalId: absent — WideMessage has no such member
    };
  }
  protected buildWrite(record: WideMessage): MessageIntegrationWrite {
    // ZERO casts — the write type matches the widened canonical scalars exactly.
    return {
      externalId: record.externalId,
      body: record.body,
    };
  }
}
`;

// Minimal tsconfig for the temp dir compilation.
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    module: 'commonjs',
    moduleResolution: 'bundler',
    target: 'es2020',
    lib: ['es2020'],
    ignoreDeprecations: '6.0',
  },
  include: ['./**/*.ts'],
}, null, 2);

// ============================================================================
// Helper: run tsc --noEmit on a directory (via tsconfig.json)
// ============================================================================

function runTsc(dir: string): { exitCode: number; output: string } {
  // Write a tsconfig so tsc picks up files from the dir.
  writeFileSync(join(dir, 'tsconfig.json'), TSCONFIG);
  const r = spawnSync('bunx', ['tsc', '--project', join(dir, 'tsconfig.json')], {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...process.env },
  });
  return {
    exitCode: r.status ?? 0,
    output: (r.stdout ?? '') + (r.stderr ?? ''),
  };
}

// ============================================================================
// §3b Tests
// ============================================================================

describe('§3b widened-canonical compile gate — emitted base accepts widened + default subclass (cast-free)', () => {
  // Generate the actual base string from the real emitter.
  const baseTs = generateSinkBase(MESSAGE_SINK_INPUT);

  // Write all files to a temp dir and compile.
  const tmpDir = mkdtempSync(join(tmpdir(), 'cgp-491-3b-'));
  writeFileSync(join(tmpDir, 'message.sink.generated.ts'), baseTs);
  writeFileSync(join(tmpDir, 'message.stub.repository.ts'), STUB_REPO_TS);
  // Stub the subsystem import (the base imports `IIntegrationSink` from the pattern-stack barrel).
  // We redirect it via an inline substitution: rewrite the import specifier to the local stub.
  const baseWithLocalImport = baseTs.replace(
    /from '@pattern-stack\/codegen\/subsystems'/,
    "from './sink.protocol.stub'",
  );
  writeFileSync(join(tmpDir, 'message.sink.generated.ts'), baseWithLocalImport);
  writeFileSync(join(tmpDir, 'sink.protocol.stub.ts'), STUB_SINK_PROTOCOL_TS);
  writeFileSync(join(tmpDir, 'message.sink.widened.default.ts'), WIDENED_SAMPLE_DEFAULT_TS);
  writeFileSync(join(tmpDir, 'message.sink.widened.ts'), WIDENED_SAMPLE_TS);

  const { exitCode, output } = runTsc(tmpDir);

  it('tsc --noEmit exits 0 (no errors) for the widened + default subclasses against the emitted base', () => {
    if (exitCode !== 0) {
      // Surface the full tsc output in the test output.
      console.error('§3b tsc full output (exit', exitCode, '):\n', output);
    }
    expect(exitCode).toBe(0);
  });

  it('the emitted base contains no ` as ` cast (projection-default subclass is cast-free)', () => {
    // The base's standalone default functions must be cast-free.
    const codeLines = baseTs.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    const castLines = codeLines.filter((l) => / as /.test(l));
    expect(castLines).toHaveLength(0);
  });

  it('the base exports defaultMessageBuildWrite and defaultMessageToCanonicalView', () => {
    expect(baseTs).toContain('export function defaultMessageBuildWrite(');
    expect(baseTs).toContain('export function defaultMessageToCanonicalView(');
  });

  it('the base exports abstract class MessageSinkBase<TCanonical = MessageIntegrationProjection>', () => {
    expect(baseTs).toContain(
      'export abstract class MessageSinkBase<TCanonical = MessageIntegrationProjection>',
    );
  });
});
