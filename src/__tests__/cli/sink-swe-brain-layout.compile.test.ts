/**
 * #528 — compile-level proof: the EMITTED sink base typechecks against the
 * swe-brain directory layout.
 *
 * Two defects made every generated `*.sink.generated.ts` base non-compiling
 * for the swe-brain layout at 0.26.0:
 *   1. repo import one `../` too deep — `../../../../modules/...` from
 *      `integrations/<surface>/sinks/` lands at the REPO ROOT, not `src/` (TS2307).
 *   2. bare `userId,` shorthand in `default<E>BuildWrite(record)` — no `userId`
 *      binding in scope (TS18004).
 *
 * The existing §3b gate (`sink-widened-canonical.gate.test.ts`) missed BOTH: it
 * rewrites the repo import to a SAME-DIR stub (never exercises depth) and uses a
 * fixture with no `user_id` field. This test runs the REAL `emitAdapters` so the
 * actual import path is emitted, builds the swe-brain tree on disk —
 *   <src>/integrations/<surface>/sinks/<entity>.sink.generated.ts
 *   <src>/modules/<plural>/<entity>.repository.ts
 * — and runs `tsc --noEmit` over the whole tree. A regression on either defect
 * fails the compile.
 */
import { describe, it, expect } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { emitAdapters } from '../../cli/shared/adapter-emission-generator';
import { loadProviderFromYaml } from '../../utils/yaml-loader';

const FIX = resolve(import.meta.dir, '../parser/fixtures/providers');

function loadDef(name: string) {
  const r = loadProviderFromYaml(resolve(FIX, name));
  if (!r.success) throw new Error(`fixture ${name} failed`);
  return r.definition;
}

// A messaging entity declaring a `user_id` field + a belongs_to FK — exercises
// the copy-through write (incl. userId: record.userId) AND the FK-null seam.
// google.yaml's `transcript` surface is reused as the provider's surface tag.
const ENTITY = {
  entity: {
    name: 'transcript',
    surface: 'transcript',
    pattern: 'Integrated',
    plural: 'transcripts',
    context: null,
  },
  fields: {
    user_id: { type: 'string' },
    title: { type: 'string' },
  },
  relationships: {},
};

// Stub the repo module the emitted base imports (projection + write + repo class).
// userId + title are on the projection; userId is on the write surface (#528 D2).
const STUB_REPO_TS = `
export interface TranscriptIntegrationProjection {
  id: string;
  externalId: string;
  userId: string;
  title: string;
}
export interface TranscriptIntegrationWrite {
  externalId: string;
  userId: string;
  title: string;
}
export class TranscriptRepository {
  async findByExternalIdProjected(_externalId: string, _provider: string): Promise<TranscriptIntegrationProjection | null> {
    return null;
  }
  async integrationUpsertOne(_write: TranscriptIntegrationWrite, _provider: string): Promise<TranscriptIntegrationProjection> {
    return null as unknown as TranscriptIntegrationProjection;
  }
  async softDeleteByExternalId(_externalId: string, _provider: string): Promise<{ id: string } | null> {
    return null;
  }
}
`;

// Stub IIntegrationSink (the base imports it from @pattern-stack/codegen/subsystems);
// redirected via a tsconfig paths alias so the temp tsc resolves it locally.
const STUB_SINK_PROTOCOL_TS = `
export interface IIntegrationSink<TCanonical> {
  findByExternalId(userId: string, externalId: string): Promise<TCanonical | null>;
  upsertByExternalId(userId: string, record: TCanonical, provider: string): Promise<{ id: string; saved: TCanonical }>;
  softDeleteByExternalId(userId: string, externalId: string): Promise<{ id: string } | null>;
}
`;

// Compile ONLY the sink seam (base + subclass) + its real on-disk repo stub +
// the IIntegrationSink stub. The same `emitAdapters` run also writes the adapter
// scaffold / assembly modules / tokens (which pull @nestjs/common, Ref, the
// use-case, etc. — out of scope for #528); narrowing `include` to the seam keeps
// this a focused compile proof of the two emitter defects (#528), exactly as the
// §3b gate compiles the base in isolation — but here with the REAL relative
// import path resolving against the swe-brain module geometry on disk.
const TSCONFIG = (subsystemsStubAbs: string, includeAbs: string[]) =>
  JSON.stringify(
    {
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        module: 'commonjs',
        moduleResolution: 'bundler',
        target: 'es2020',
        lib: ['es2020'],
        ignoreDeprecations: '6.0',
        baseUrl: '.',
        paths: {
          '@pattern-stack/codegen/subsystems': [subsystemsStubAbs.replace(/\.ts$/, '')],
        },
      },
      files: includeAbs,
    },
    null,
    2,
  );

describe('#528 — emitted sink base compiles against the swe-brain layout', () => {
  // Build <root>/src as the backend src root; outputRoot = <src>/integrations.
  const root = mkdtempSync(join(tmpdir(), 'cgp-528-compile-'));
  const srcAbs = join(root, 'src');
  const outRoot = join(srcAbs, 'integrations');

  // The repo stub at the swe-brain module path: <src>/modules/transcripts/transcript.repository.ts
  const repoAbs = join(srcAbs, 'modules', 'transcripts', 'transcript.repository.ts');
  mkdirSync(dirname(repoAbs), { recursive: true });
  writeFileSync(repoAbs, STUB_REPO_TS);

  // IIntegrationSink stub anywhere under src; aliased into the base's import.
  const sinkProtoAbs = join(srcAbs, 'stubs', 'sink.protocol.stub.ts');
  mkdirSync(dirname(sinkProtoAbs), { recursive: true });
  writeFileSync(sinkProtoAbs, STUB_SINK_PROTOCOL_TS);

  // Run the REAL emitter — package mode emits the @pattern-stack/codegen/subsystems import.
  const res = emitAdapters({
    providers: [{ definition: loadDef('google.yaml'), filePath: resolve(FIX, 'google.yaml') }],
    entities: [ENTITY],
    outputRoot: outRoot,
    backendSrcAbs: srcAbs,
    aliases: {}, // relative-path layout (the failing swe-brain case)
    mode: 'package',
  });

  const baseAbs = join(outRoot, 'transcript', 'sinks', 'transcript.sink.generated.ts');
  const subclassAbs = join(outRoot, 'transcript', 'sinks', 'transcript.sink.ts');

  // Compile the seam (base + subclass) + the real repo stub + the protocol stub.
  const tsconfigAbs = join(srcAbs, 'tsconfig.seam.json');
  writeFileSync(
    tsconfigAbs,
    TSCONFIG(sinkProtoAbs, [baseAbs, subclassAbs, repoAbs, sinkProtoAbs]),
  );
  const tsc = spawnSync('bunx', ['tsc', '--project', tsconfigAbs], {
    cwd: srcAbs,
    encoding: 'utf-8',
    env: { ...process.env },
  });
  const tscOut = (tsc.stdout ?? '') + (tsc.stderr ?? '');

  it('emitAdapters wrote the base into integrations/<surface>/sinks/', () => {
    expect(res.written).toContain(baseAbs);
  });

  it('D1: the repo import is ../../../modules/... (3 levels, not 4)', () => {
    const base = readFileSync(baseAbs, 'utf-8');
    expect(base).toContain("from '../../../modules/transcripts/transcript.repository'");
    expect(base).not.toContain('../../../../modules/transcripts/transcript.repository');
  });

  it('D2: the write reads userId from the record (no bare shorthand)', () => {
    const base = readFileSync(baseAbs, 'utf-8');
    const writeBlock = base.slice(
      base.indexOf('export function defaultTranscriptBuildWrite('),
      base.indexOf('export function defaultTranscriptToCanonicalView('),
    );
    expect(writeBlock).toContain('userId: record.userId,');
    expect(writeBlock).not.toMatch(/^\s*userId,\s*$/m);
  });

  it('tsc --noEmit exits 0 against the swe-brain layout (both defects fixed)', () => {
    if ((tsc.status ?? 0) !== 0) {
      console.error('#528 compile gate tsc output (exit', tsc.status, '):\n', tscOut);
    }
    expect(tsc.status).toBe(0);
  });
});
