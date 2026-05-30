/**
 * Template rendering tests for controller + read-path hardening.
 *
 * Covers:
 *   D2 — find-by-id use case throws NotFoundException on null/undefined
 *        (prevents 200 OK empty-body responses for unknown ids).
 *   D3 — generated controller applies ParseUUIDPipe to every @Param('id'),
 *        preventing malformed UUIDs from reaching the DB and surfacing as 500.
 *   D4/D5 — generated controller wires a ZodValidationPipe on @Body() for
 *        create/update, giving runtime Zod validation at the controller
 *        boundary (not just compile-time TS types).
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
  return ejs.render(extractBody(readTemplate(relPath)), locals, {
    rmWhitespace: false,
  });
}

const baseEntity = {
  entity: {
    name: 'contact',
    plural: 'contacts',
    table: 'contacts',
    pattern: 'Integrated',
  },
  fields: {
    email: { type: 'string', required: true },
  },
  relationships: {},
  behaviors: ['timestamps'],
};

describe('clean-lite-ps find-by-id use case — throws NotFoundException (D2)', () => {
  it('imports NotFoundException and throws when the service returns null', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('use-cases/find-by-id.ejs.t', locals);

    expect(output).toContain(
      "import { Injectable, NotFoundException } from '@nestjs/common';",
    );
    expect(output).toContain('throw new NotFoundException(');
    expect(output).toContain('Contact not found:');
  });

  it('return type is non-nullable (Promise<Entity>, not Promise<Entity | null>)', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('use-cases/find-by-id.ejs.t', locals);

    expect(output).toContain('async execute(id: string): Promise<Contact>');
    expect(output).not.toContain('Promise<Contact | null>');
  });
});

describe('clean-lite-ps controller — ParseUUIDPipe on @Param (D3)', () => {
  it('applies ParseUUIDPipe to the getById @Param', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('controller.ejs.t', locals);

    expect(output).toContain('ParseUUIDPipe');
    expect(output).toContain("@Param('id', ParseUUIDPipe)");
  });

  it('applies ParseUUIDPipe to update and delete @Param as well', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('controller.ejs.t', locals);

    // Count the uses — read (1) + update (1) + delete (1) = at least 3.
    const matches = output.match(/@Param\('id', ParseUUIDPipe\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
    // The raw, unguarded form must not appear anywhere.
    expect(output).not.toContain("@Param('id') id: string");
  });

  it('imports ParseUUIDPipe from @nestjs/common', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('controller.ejs.t', locals);

    // Grab the first import line from @nestjs/common and assert membership.
    const importMatch = output.match(
      /import \{([^}]+)\} from '@nestjs\/common';/,
    );
    expect(importMatch).not.toBeNull();
    expect(importMatch![1]).toContain('ParseUUIDPipe');
  });
});

describe('clean-lite-ps controller — ZodValidationPipe on @Body (D4/D5)', () => {
  it('imports ZodValidationPipe + create/update schemas', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('controller.ejs.t', locals);

    expect(output).toContain(
      "import { ZodValidationPipe } from '@shared/pipes/zod-validation.pipe';",
    );
    expect(output).toContain(
      "import { CreateContactSchema } from './dto/create-contact.dto';",
    );
    expect(output).toContain(
      "import { UpdateContactSchema } from './dto/update-contact.dto';",
    );
  });

  it('wires ZodValidationPipe on POST and PATCH @Body parameters', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('controller.ejs.t', locals);

    expect(output).toContain(
      '@Body(new ZodValidationPipe(CreateContactSchema)) dto: CreateContactDto',
    );
    expect(output).toContain(
      '@Body(new ZodValidationPipe(UpdateContactSchema)) dto: UpdateContactDto',
    );
    // Raw unguarded @Body() must not appear.
    expect(output).not.toContain('@Body() dto:');
  });

  it('does not emit ZodValidationPipe when writes are disabled', () => {
    const def = { ...baseEntity, generate: { writes: false } };
    const locals = buildCleanLitePsLocals(def, {});
    const output = render('controller.ejs.t', locals);

    expect(output).not.toContain('ZodValidationPipe');
    expect(output).not.toContain('CreateContactSchema');
    expect(output).not.toContain('UpdateContactSchema');
  });
});

describe('clean-lite-ps DTOs — schemas are exported as runtime values (D4/D5)', () => {
  // The controller pipe instantiates `new ZodValidationPipe(CreateXSchema)`
  // at runtime, so the schema must be a regular (non-type-only) export.
  it('create DTO exports CreateXSchema as a value', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('dto/create.ejs.t', locals);

    expect(output).toContain('export const CreateContactSchema = z.object({');
  });

  it('update DTO exports UpdateXSchema as a value', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('dto/update.ejs.t', locals);

    expect(output).toContain('export const UpdateContactSchema');
  });
});
