/**
 * ADR-033.1 c — Provider-keyed integration-source module emission.
 *
 * Verifies the rendered <entity>-integration-source.module.ts:
 *   1. Emits a single module per entity, regardless of provider count.
 *   2. Exports exactly <ENTITY>_POLL_FETCH_REGISTRY and <ENTITY>_CHANGE_SOURCES
 *      (plus the module class). <ENTITY>_DETECTION_CONFIGS stays internal.
 *   3. Provider keys appear as data only — the configs map and never as
 *      generated TS symbols.
 *   4. Iterates `Object.entries` once for both single- and multi-provider
 *      cases — no `isMultiProvider` branch.
 *   5. Typechecks against the runtime types (buildChangeSource,
 *      IChangeSource<T>, PollFetchCallback<T>) under the same strict
 *      tsconfig the smoke test uses.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import ejs from 'ejs';

const TEMPLATE_PATH = resolve(
  import.meta.dir,
  '../../../templates/entity/new/backend/modules/core/integration-source.ejs.t',
);
const RUNTIME_INTEGRATION_DIR = resolve(import.meta.dir, '../../../runtime/subsystems/integration');

function extractBody(source: string): string {
  const lines = source.split('\n');
  if (lines[0] !== '---') return source;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return source;
  return lines.slice(end + 1).join('\n');
}

function renderModule(detectionBlock: Record<string, unknown>): string {
  const body = extractBody(readFileSync(TEMPLATE_PATH, 'utf8'));
  return ejs.render(body, {
    name: 'opportunity',
    className: 'Opportunity',
    hasDetection: Object.keys(detectionBlock).length > 0,
    detectionConfigsLiteral: JSON.stringify(detectionBlock, null, 2),
    imports: { moduleToDomain: '../domain' },
    isCleanLitePs: false,
    clpOutputPaths: undefined,
    clpImports: undefined,
  });
}

const TWO_PROVIDERS = {
  'hubspot-crm': {
    mode: 'poll',
    poll: { cursor: { kind: 'timestamp', field: 'hs_lastmodifieddate' } },
    mapping: [{ source: 'dealname', target: 'name' }],
    filters: [],
  },
  'salesforce-crm': {
    mode: 'poll',
    poll: { cursor: { kind: 'systemModstamp', field: 'SystemModstamp' } },
    mapping: [{ source: 'Name', target: 'name' }],
    filters: [],
  },
};

describe('integration-source.ejs.t (ADR-033.1 c)', () => {
  it('emits exactly two exported runtime symbols + the module class', () => {
    const out = renderModule(TWO_PROVIDERS);
    expect(out).toMatch(/export const OPPORTUNITY_POLL_FETCH_REGISTRY = Symbol\('OPPORTUNITY_POLL_FETCH_REGISTRY'\);/);
    expect(out).toMatch(/export const OPPORTUNITY_CHANGE_SOURCES = Symbol\('OPPORTUNITY_CHANGE_SOURCES'\);/);
    expect(out).toMatch(/export class OpportunityIntegrationSourceModule \{\}/);
    // <ENTITY>_DETECTION_CONFIGS is module-internal; not exported.
    expect(out).not.toMatch(/export const OPPORTUNITY_DETECTION_CONFIGS/);
  });

  it('returns ReadonlyMap (not Map) and uses Object.entries — no isMultiProvider branch', () => {
    const out = renderModule(TWO_PROVIDERS);
    expect(out).toContain('ReadonlyMap<string, IChangeSource<Opportunity>>');
    expect(out).toContain('Object.entries(OPPORTUNITY_DETECTION_CONFIGS)');
    expect(out).not.toMatch(/isMultiProvider/);
  });

  it('preserves YAML insertion order in the configs map', () => {
    const out = renderModule(TWO_PROVIDERS);
    const hubspotIdx = out.indexOf('"hubspot-crm"');
    const salesforceIdx = out.indexOf('"salesforce-crm"');
    expect(hubspotIdx).toBeGreaterThan(-1);
    expect(salesforceIdx).toBeGreaterThan(hubspotIdx);
  });

  it('emits one module for the single-provider case (same template path)', () => {
    const out = renderModule({ 'hubspot-crm': TWO_PROVIDERS['hubspot-crm'] });
    expect(out).toContain('"hubspot-crm"');
    expect(out).not.toContain('"salesforce-crm"');
    expect(out).toMatch(/export class OpportunityIntegrationSourceModule \{\}/);
  });

  it('typechecks the rendered module against runtime integration types under strict + noUncheckedIndexedAccess', () => {
    const dir = mkdtempSync(join(tmpdir(), 'integration-source-typecheck-'));
    try {
      const integrationDir = join(dir, 'integration');
      mkdirSync(integrationDir, { recursive: true });
      // Vendor the runtime integration source files (excluding the drizzle backends
      // and the audit schema, which depend on a generated `tenantId` column
      // emitted by a separate Hygen template — orthogonal to this test).
      for (const file of readdirSync(RUNTIME_INTEGRATION_DIR)) {
        if (file.endsWith('.drizzle-backend.ts')) continue;
        if (file === 'integration-audit.schema.ts') continue;
        copyFileSync(join(RUNTIME_INTEGRATION_DIR, file), join(integrationDir, file));
      }
      // Trim the barrel so it doesn't re-export the drizzle backends or
      // the audit schema we omitted.
      const trimmedBarrel = readFileSync(join(integrationDir, 'index.ts'), 'utf8')
        .replace(/^.*\.drizzle-backend.*$/gm, '')
        .replace(/^.*integration-audit\.schema.*$/gm, '');
      writeFileSync(join(integrationDir, 'index.ts'), trimmedBarrel, 'utf8');

      // Stub @nestjs/common — only the @Module decorator is referenced.
      const nestDir = join(dir, 'nest');
      mkdirSync(nestDir, { recursive: true });
      writeFileSync(
        join(nestDir, 'common.ts'),
        'export function Module(_: unknown): ClassDecorator { return () => {}; }\n',
        'utf8',
      );

      // Stub @shared/openapi (transitively imported via base-classes)? Not
      // needed — this slice only imports from @shared/subsystems/integration and
      // @nestjs/common. Provide a minimal Opportunity domain stub.
      const domainDir = join(dir, 'domain');
      mkdirSync(domainDir, { recursive: true });
      writeFileSync(
        join(domainDir, 'index.ts'),
        'export interface Opportunity { id: string; }\n',
        'utf8',
      );

      // Render + write the module under test.
      writeFileSync(
        join(dir, 'opportunity-integration-source.module.ts'),
        renderModule(TWO_PROVIDERS),
        'utf8',
      );

      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify(
          {
            compilerOptions: {
              target: 'es2022',
              module: 'esnext',
              moduleResolution: 'bundler',
              strict: true,
              skipLibCheck: true,
              noEmit: true,
              noUncheckedIndexedAccess: true,
              experimentalDecorators: true,
              emitDecoratorMetadata: true,
              baseUrl: '.',
              paths: {
                '@nestjs/common': ['./nest/common.ts'],
                '@shared/subsystems/integration': ['./integration/index.ts'],
              },
            },
            include: ['*.ts', 'integration/**/*.ts', 'nest/**/*.ts', 'domain/**/*.ts'],
          },
          null,
          2,
        ),
        'utf8',
      );

      const r = spawnSync('bunx', ['tsc', '--noEmit', '-p', dir], {
        cwd: dir,
        encoding: 'utf8',
      });
      const output = (r.stdout || '') + (r.stderr || '');
      // We only care about errors in the rendered module itself.
      const moduleErrors = output
        .split('\n')
        .filter((line) => line.includes('opportunity-integration-source.module.ts'));
      if (moduleErrors.length > 0) {
        // surface the diagnostics for debugging
        // eslint-disable-next-line no-console
        console.error(moduleErrors.join('\n'));
      }
      expect(moduleErrors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
