/**
 * Template rendering tests for clean-lite-ps DTO templates.
 *
 * Covers the Zod type map fixes from issue #35:
 *   - PG `numeric` (YAML `decimal`) is returned by Drizzle as a string, so
 *     the emitted Zod must be `z.coerce.number()` (not `z.number()`) to
 *     parse string inputs at the boundary.
 *   - `jsonb` routinely stores arrays, not just records — the emitted Zod
 *     must be `z.unknown()` (not `z.record(z.unknown())`) so arrays pass
 *     validation.
 *
 * This is a template-level regression test (not a baseline snapshot)
 * because clean-lite-ps is not part of test/baseline.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ejs from 'ejs';
import { buildCleanLitePsLocals } from '../../../templates/entity/new/clean-lite-ps/prompt-extension.js';

const TEMPLATES_DIR = resolve(
  import.meta.dir,
  '../../../templates/entity/new/clean-lite-ps/dto',
);

const CREATE_TEMPLATE = readFileSync(resolve(TEMPLATES_DIR, 'create.ejs.t'), 'utf8');
const OUTPUT_TEMPLATE = readFileSync(resolve(TEMPLATES_DIR, 'output.ejs.t'), 'utf8');
const UPDATE_TEMPLATE = readFileSync(resolve(TEMPLATES_DIR, 'update.ejs.t'), 'utf8');

/**
 * Strip the Hygen front-matter (the `---` block at the top) so we render
 * only the body, matching what Hygen itself does before handing the body
 * to EJS.
 */
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

function render(template: string, locals: Record<string, unknown>): string {
  return ejs.render(extractBody(template), locals, { rmWhitespace: false });
}

// Fixture with a decimal field and a json field — covers both bugs.
const agentDefinition = {
  entity: { name: 'agent', plural: 'agents', table: 'agents', family: 'synced' },
  fields: {
    name: { type: 'string', required: true },
    temperature: { type: 'decimal', required: true },
    tools: { type: 'json', nullable: true },
    config: { type: 'json', required: true },
  },
  relationships: {},
  behaviors: [],
};

describe('clean-lite-ps DTO templates — Zod type leaks (issue #35)', () => {
  describe('decimal field → z.coerce.number()', () => {
    it('create DTO emits z.coerce.number() for decimal', () => {
      const locals = buildCleanLitePsLocals(agentDefinition, {});
      const output = render(CREATE_TEMPLATE, locals);

      expect(output).toContain('temperature: z.coerce.number()');
      // Bare z.number() on a decimal field is the bug we are fixing.
      expect(output).not.toMatch(/temperature:\s*z\.number\(\)/);
    });

    it('output DTO emits z.coerce.number() for decimal', () => {
      const locals = buildCleanLitePsLocals(agentDefinition, {});
      const output = render(OUTPUT_TEMPLATE, locals);

      expect(output).toContain('temperature: z.coerce.number()');
      expect(output).not.toMatch(/temperature:\s*z\.number\(\)/);
    });

    it('update DTO inherits coerced decimal via createSchema.partial()', () => {
      const locals = buildCleanLitePsLocals(agentDefinition, {});
      const output = render(UPDATE_TEMPLATE, locals);

      // The update schema is derived from the create schema, so the
      // coercion propagates automatically. We just assert the derivation
      // is intact.
      expect(output).toContain('CreateAgentSchema.partial()');
    });
  });

  describe('json field → z.unknown()', () => {
    it('create DTO emits z.unknown() for json (not z.record)', () => {
      const locals = buildCleanLitePsLocals(agentDefinition, {});
      const output = render(CREATE_TEMPLATE, locals);

      // Required json field
      expect(output).toMatch(/config:\s*z\.unknown\(\)/);
      // Nullable json field
      expect(output).toMatch(/tools:\s*z\.unknown\(\)\.nullable\(\)/);
      // Never the old record(...) form — it rejects arrays.
      expect(output).not.toContain('z.record(');
    });

    it('output DTO emits z.unknown() for json (not z.record)', () => {
      const locals = buildCleanLitePsLocals(agentDefinition, {});
      const output = render(OUTPUT_TEMPLATE, locals);

      expect(output).toMatch(/config:\s*z\.unknown\(\)/);
      expect(output).toMatch(/tools:\s*z\.unknown\(\)\.nullable\(\)/);
      expect(output).not.toContain('z.record(');
    });
  });
});
