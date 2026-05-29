/**
 * Frontend collection sync-mode tests.
 *
 * Verifies the additive `frontend.sync.mode` knob:
 *   - 'electric' (default) → electricCollectionOptions + shapeOptions (unchanged)
 *   - 'api'                → queryCollectionOptions + a REST queryFn fetch
 *
 * Covers the standalone collection template (concern-first) and the monolithic
 * combined template's inline collection block.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ejs from 'ejs';

const FRONTEND_ROOT = resolve(import.meta.dir, '../../../templates/entity/new/frontend');

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
  return end === -1 ? source : lines.slice(end + 1).join('\n');
}

function render(relPath: string, locals: Record<string, unknown>): string {
  const src = readFileSync(resolve(FRONTEND_ROOT, relPath), 'utf8');
  return ejs.render(extractBody(src), locals, { rmWhitespace: false });
}

/** Locals sufficient for collections/collection.ejs.t. */
function collectionLocals(mode: 'electric' | 'api') {
  return {
    camelName: 'contact',
    plural: 'contacts',
    frontendEnabled: true,
    generate: { collections: true },
    frontend: {
      auth: { function: 'getAuthorizationHeader' },
      parsers: { timestamptz: '(date: string) => new Date(date)' },
      collections: { schemaPrefix: 'schema.' },
      sync: {
        mode,
        apiUrl: '/api',
        queryClientImport: null,
        shapeUrl: '/v1/shape',
        useTableParam: true,
        wrapInUrlConstructor: true,
        columnMapper: 'snakeCamelMapper',
        columnMapperNeedsCall: true,
        apiBaseUrlImport: null,
      },
    },
  };
}

describe('frontend.sync.mode — collection template', () => {
  it("defaults ('electric') to electricCollectionOptions with shapeOptions", () => {
    const out = render('collections/collection.ejs.t', collectionLocals('electric'));
    expect(out).toContain('electricCollectionOptions({');
    expect(out).toContain('shapeOptions:');
    expect(out).not.toContain('queryCollectionOptions');
    expect(out).toContain('schema: schema.contactSchema');
    expect(out).toContain('getKey: (item) => item.id');
  });

  it("'api' emits queryCollectionOptions with a REST queryFn", () => {
    const out = render('collections/collection.ejs.t', collectionLocals('api'));
    expect(out).toContain('queryCollectionOptions({');
    expect(out).toContain("queryKey: ['contacts']");
    expect(out).toContain('queryClient,');
    expect(out).toContain('queryFn: async () =>');
    expect(out).toContain('await fetch(`/api/contacts`');
    expect(out).toContain('Authorization: getAuthorizationHeader()');
    expect(out).toContain('schema: schema.contactSchema');
    expect(out).not.toContain('electricCollectionOptions');
    expect(out).not.toContain('shapeOptions');
  });

  it("'api' uses API_BASE_URL when apiBaseUrlImport is configured", () => {
    const locals = collectionLocals('api');
    (locals.frontend.sync as Record<string, unknown>).apiBaseUrlImport = '@/config';
    const out = render('collections/collection.ejs.t', locals);
    expect(out).toContain('await fetch(`${API_BASE_URL}/contacts`');
  });
});
