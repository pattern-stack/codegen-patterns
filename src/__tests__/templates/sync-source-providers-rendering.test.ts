/**
 * ADR-033.2 — Typed provider artifacts (sync-source.providers.ts).
 *
 * Two assertions:
 *   1. Template renders the expected tuple + literal-union shape, with
 *      provider keys in YAML insertion order, and no NestJS imports.
 *   2. Negative-case typecheck: a consumer registry typed as
 *      Record<<EntityName>Provider, ...> with a typo'd key fails
 *      `tsc --noEmit`. The TS error IS the test.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import ejs from 'ejs';

const TEMPLATE_PATH = resolve(
  import.meta.dir,
  '../../../templates/entity/new/backend/modules/core/sync-source.providers.ejs.t',
);

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

function renderProviders(detectionProviders: string[]): string {
  const body = extractBody(readFileSync(TEMPLATE_PATH, 'utf8'));
  return ejs.render(body, {
    name: 'opportunity',
    className: 'Opportunity',
    detectionProviders,
    hasDetection: detectionProviders.length > 0,
  });
}

describe('sync-source.providers template (ADR-033.2)', () => {
  it('emits SCREAMING_SNAKE tuple + PascalCase literal-union, in YAML insertion order', () => {
    const out = renderProviders(['hubspot-crm', 'salesforce-crm']);
    expect(out).toContain(
      "export const OPPORTUNITY_PROVIDERS = ['hubspot-crm', 'salesforce-crm'] as const;",
    );
    expect(out).toContain(
      'export type OpportunityProvider = (typeof OPPORTUNITY_PROVIDERS)[number];',
    );
  });

  it('preserves YAML insertion order (sf before hs)', () => {
    const out = renderProviders(['salesforce-crm', 'hubspot-crm']);
    expect(out).toContain(
      "['salesforce-crm', 'hubspot-crm']",
    );
  });

  it('handles single-provider case', () => {
    const out = renderProviders(['hubspot-crm']);
    expect(out).toContain(
      "export const OPPORTUNITY_PROVIDERS = ['hubspot-crm'] as const;",
    );
  });

  it('imports nothing from @nestjs/common (type-only consumption stays NestJS-free)', () => {
    const out = renderProviders(['hubspot-crm', 'salesforce-crm']);
    expect(out).not.toContain('@nestjs/common');
    expect(out).not.toMatch(/\bimport\b/);
  });

  it('typo in consumer registry key fails tsc --noEmit (negative-case)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'providers-neg-'));
    try {
      // Generated artifact (rendered fresh from the template).
      writeFileSync(
        join(dir, 'opportunity-sync-source.providers.ts'),
        renderProviders(['hubspot-crm', 'salesforce-crm']),
        'utf8',
      );

      // Consumer file with a typo'd key. Record<OpportunityProvider, …>
      // forces the TS compiler to require all literal-union keys; the
      // typo'd 'hubspot-cmr' is not in the union and the missing
      // 'hubspot-crm' makes the record incomplete. Either failure is
      // fine — the test is "compilation fails."
      writeFileSync(
        join(dir, 'consumer.ts'),
        [
          "import type { OpportunityProvider } from './opportunity-sync-source.providers';",
          "type Fetch = () => Promise<void>;",
          "const registry: Record<OpportunityProvider, Fetch> = {",
          "  'hubspot-cmr': async () => {},",
          "  'salesforce-crm': async () => {},",
          "};",
          "void registry;",
          "",
        ].join('\n'),
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
              noEmit: true,
              skipLibCheck: true,
            },
            include: ['*.ts'],
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
      // Compilation MUST fail. The exact diagnostic code may be TS2322
      // (incompatible type), TS2353 (excess property), or TS7053 — any
      // hard failure on the consumer.ts is acceptable; what we forbid is
      // a clean exit.
      expect(r.status).not.toBe(0);
      expect(output).toMatch(/consumer\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
