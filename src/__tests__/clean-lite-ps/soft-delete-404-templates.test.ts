/**
 * Template rendering tests for clean-lite-ps 404 semantics on :id routes
 * (task #19).
 *
 * With soft-delete enabled, BaseRepository.baseQuery() filters
 * `deletedAt IS NULL` — so `service.findById(id)` returns null for
 * soft-deleted rows. Previously the generated controller returned null
 * verbatim, yielding 200 null. That's convention-wrong; REST clients
 * expect 404.
 *
 * Fix: on every `:id` GET + PATCH route, template guards the service
 * result with `if (!entity) throw new NotFoundException(...)`. Applies
 * to findById, findByIdWithFields (EAV), and update routes.
 *
 * DELETE already returns Promise<void> (see PR #52 dogfooding fix) —
 * idempotent, no 404 needed.
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
  entity: { name: 'contact', plural: 'contacts', table: 'contacts', pattern: 'Integrated' },
  fields: { email: { type: 'string', required: true } },
  relationships: {},
  behaviors: ['timestamps', 'soft_delete'],
};

const eavEntity = { ...baseEntity, eav: true };

describe('clean-lite-ps controller 404 semantics on :id routes', () => {
  it('imports NotFoundException from @nestjs/common', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('controller.ejs.t', locals);

    expect(output).toContain('NotFoundException');
    // The import line must include it alongside Controller, Get, etc.
    expect(output).toMatch(/import\s*\{[^}]*NotFoundException[^}]*\}\s*from\s*'@nestjs\/common'/);
  });

  it('GET /:id returns Promise<Entity> — use case throws 404 when null (D2)', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('controller.ejs.t', locals);

    // D3 + D2 combined: ParseUUIDPipe guards the id; find-by-id use case
    // throws NotFoundException on null, so the controller is a one-liner.
    expect(output).toContain("async getById(@Param('id', ParseUUIDPipe) id: string): Promise<Contact> {");
    expect(output).toContain('return this.findByIdUseCase.execute(id);');

    // And the nullable return type is gone from the :id signature.
    expect(output).not.toContain('Promise<Contact | null>');
  });

  it('PATCH /:id throws 404 when the row does not exist', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('controller.ejs.t', locals);

    // ADR-043 §5: no header-threaded actor — use-case reads the principal from ALS.
    expect(output).toContain(
      'const entity = await this.updateUseCase.execute(id, dto);',
    );
    expect(output).toContain('if (!entity) throw new NotFoundException(`Contact ${id} not found`);');
    // Signature returns Promise<Entity>, not Entity | null.
    expect(output).toMatch(/async update\([\s\S]*?\): Promise<Contact> \{/);
  });

  it('DELETE /:id stays void (idempotent, no 404)', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('controller.ejs.t', locals);

    // Per PR #52 dogfooding fix, delete is void. Double-check the 404
    // change didn't regress this. D3 adds ParseUUIDPipe to the @Param.
    // ADR-043 §5: delete signature carries only the id (no header actor).
    expect(output).toMatch(
      /async remove\([\s\S]*?@Param\('id', ParseUUIDPipe\) id: string[\s\S]*?\): Promise<void>/,
    );
    // No NotFoundException in the delete body — idempotent semantics.
    expect(output).not.toMatch(/remove[\s\S]*?throw new NotFoundException/);
  });

  it('EAV paired read /:id/with-fields also throws 404 on null', () => {
    const locals = buildCleanLitePsLocals(eavEntity, {});
    const output = render('controller.ejs.t', locals);

    expect(output).toContain('const entity = await this.findByIdWithFieldsUseCase.execute(id);');
    expect(output).toContain('if (!entity) throw new NotFoundException(`Contact ${id} not found`);');
    // Signature type widens to include the fields bag but drops | null.
    expect(output).toMatch(/Promise<Contact & \{ fields: Record<string, unknown> \}>/);
    expect(output).not.toContain('Promise<(Contact & { fields: Record<string, unknown> }) | null>');
  });

  it('list route (no :id) returns a Page<T> envelope, not a bare array (no 404 logic)', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('controller.ejs.t', locals);

    // pagination-by-default: @Get() returns Page<Contact>, binds the ListQuery,
    // and carries no 404 logic (an empty page is a valid result).
    expect(output).toMatch(/@Get\(\)\s+async getAll\(/);
    expect(output).toContain('): Promise<Page<Contact>> {');
    expect(output).toContain('return this.listUseCase.execute(query);');
    expect(output).not.toContain('Promise<Contact[]>');
  });
});
