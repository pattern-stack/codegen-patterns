/**
 * Template rendering tests for clean-lite-ps runtime Zod validation
 * on write routes (task #18).
 *
 * Generated controllers previously did `@Body() dto: CreateXDto` — the
 * DTO was a Zod-inferred TypeScript type, not a runtime validator. NestJS
 * passed the raw request body through unchanged, so `z.coerce.date()`
 * / `z.coerce.string()` / enum validation never fired. First hit: coord-A
 * A2 smoke test — `POST /opportunities` with `closeDate: "2026-09-30"`
 * crashed at the Drizzle column boundary with
 * `value.toISOString is not a function`.
 *
 * Fix: template emits
 *   @Body(new ZodValidationPipe(CreateXSchema)) dto: CreateXDto
 * and the consumer provides ZodValidationPipe in @shared/pipes/.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ejs from 'ejs';
import { buildCleanLitePsLocals } from '../../../templates/entity/new/clean-lite-ps/prompt-extension.js';

const TEMPLATE_ROOT = resolve(
  import.meta.dir,
  '../../../templates/entity/new/clean-lite-ps',
);

function readTemplate(relPath: string): string {
  return readFileSync(resolve(TEMPLATE_ROOT, relPath), 'utf8');
}

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

function render(relPath: string, locals: Record<string, unknown>): string {
  return ejs.render(extractBody(readTemplate(relPath)), locals, { rmWhitespace: false });
}

const baseEntity = {
  entity: { name: 'contact', plural: 'contacts', table: 'contacts', pattern: 'Synced' },
  fields: {
    email: { type: 'string', required: true },
  },
  relationships: {},
  behaviors: ['timestamps'],
};

describe('clean-lite-ps zod validation pipe — controller', () => {
  it('imports ZodValidationPipe + value-level schemas on write routes', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('controller.ejs.t', locals);

    expect(output).toContain("import { ZodValidationPipe } from '@shared/pipes/zod-validation.pipe';");
    expect(output).toContain(
      "import { CreateContactSchema } from './dto/create-contact.dto';",
    );
    expect(output).toContain(
      "import type { CreateContactDto } from './dto/create-contact.dto';",
    );
    expect(output).toContain(
      "import { UpdateContactSchema } from './dto/update-contact.dto';",
    );
    expect(output).toContain(
      "import type { UpdateContactDto } from './dto/update-contact.dto';",
    );
  });

  it('wraps @Body with ZodValidationPipe(schema) on POST + PATCH', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('controller.ejs.t', locals);

    expect(output).toContain('@Body(new ZodValidationPipe(CreateContactSchema)) dto: CreateContactDto');
    expect(output).toContain('@Body(new ZodValidationPipe(UpdateContactSchema)) dto: UpdateContactDto');

    // And confirm the bare `@Body()` shape is gone — that's the bug we're
    // fixing. Any residual `@Body() dto:` indicates a write route that
    // didn't get the pipe.
    expect(output).not.toMatch(/@Body\(\)\s+dto:/);
  });

  it('does not import ZodValidationPipe when generate.writes is false', () => {
    const def = { ...baseEntity, generate: { writes: false } };
    const locals = buildCleanLitePsLocals(def, {});
    const output = render('controller.ejs.t', locals);

    expect(output).not.toContain('ZodValidationPipe');
    expect(output).not.toContain('CreateContactSchema');
    expect(output).not.toContain('UpdateContactSchema');
  });
});
