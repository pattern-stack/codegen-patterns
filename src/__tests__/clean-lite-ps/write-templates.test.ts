/**
 * Template rendering tests for clean-lite-ps write use-case + controller/module
 * emission (create, update, delete).
 *
 * Verifies:
 * - prompt-extension exposes class names + output paths for the three write use cases
 * - The three use-case templates render with the expected class shape and body
 * - The controller template wires POST/PATCH/DELETE routes and the right imports
 * - The module template registers the new providers
 * - `generate.writes: false` suppresses emission (paths null, controller is writes-free)
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

/** Strip Hygen front-matter so EJS sees only the body. */
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
    family: 'synced',
  },
  fields: {
    email: { type: 'string', required: true },
  },
  relationships: {},
  behaviors: ['timestamps'],
};

describe('clean-lite-ps write templates — prompt-extension wiring', () => {
  it('exposes create/update/delete use-case class names by default', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});

    expect(locals.classNames.createUseCase).toBe('CreateContactUseCase');
    expect(locals.classNames.updateUseCase).toBe('UpdateContactUseCase');
    expect(locals.classNames.deleteUseCase).toBe('DeleteContactUseCase');
  });

  it('exposes create/update/delete use-case output paths by default', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});

    expect(locals.clpOutputPaths.createUseCase).toBe(
      'src/modules/contacts/use-cases/create-contact.use-case.ts',
    );
    expect(locals.clpOutputPaths.updateUseCase).toBe(
      'src/modules/contacts/use-cases/update-contact.use-case.ts',
    );
    expect(locals.clpOutputPaths.deleteUseCase).toBe(
      'src/modules/contacts/use-cases/delete-contact.use-case.ts',
    );
    expect(locals.generateWrites).toBe(true);
  });

  it('nulls write use-case output paths when generate.writes is false', () => {
    const def = { ...baseEntity, generate: { writes: false } };
    const locals = buildCleanLitePsLocals(def, {});

    expect(locals.generateWrites).toBe(false);
    expect(locals.clpOutputPaths.createUseCase).toBeNull();
    expect(locals.clpOutputPaths.updateUseCase).toBeNull();
    expect(locals.clpOutputPaths.deleteUseCase).toBeNull();
    // Class names remain so read-side templates don't need to guard on them.
    expect(locals.classNames.createUseCase).toBe('CreateContactUseCase');
  });
});

describe('clean-lite-ps write templates — use-case rendering', () => {
  it('create.ejs.t emits a Create<Entity>UseCase with one-line service delegate', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('use-cases/create.ejs.t', locals);

    expect(output).toContain('export class CreateContactUseCase');
    expect(output).toContain(
      "import { ContactService } from '../contact.service';",
    );
    expect(output).toContain(
      "import type { CreateContactDto } from '../dto/create-contact.dto';",
    );
    expect(output).toContain(
      'async execute(dto: CreateContactDto): Promise<Contact>',
    );
    expect(output).toContain('return this.service.create(dto);');
  });

  it('update.ejs.t emits an Update<Entity>UseCase returning nullable entity', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('use-cases/update.ejs.t', locals);

    expect(output).toContain('export class UpdateContactUseCase');
    expect(output).toContain(
      "import type { UpdateContactDto } from '../dto/update-contact.dto';",
    );
    expect(output).toContain(
      'async execute(id: string, dto: UpdateContactDto): Promise<Contact | null>',
    );
    expect(output).toContain('return this.service.update(id, dto);');
  });

  it('delete.ejs.t emits a Delete<Entity>UseCase returning void', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('use-cases/delete.ejs.t', locals);

    expect(output).toContain('export class DeleteContactUseCase');
    expect(output).toContain(
      'async execute(id: string): Promise<void>',
    );
    expect(output).toContain('return this.service.delete(id);');
  });
});

describe('clean-lite-ps write templates — controller rendering', () => {
  it('wires POST/PATCH/DELETE routes and imports write use cases by default', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('controller.ejs.t', locals);

    // Imports
    expect(output).toContain('Post');
    expect(output).toContain('Patch');
    expect(output).toContain('Delete');
    expect(output).toContain('Body');
    expect(output).toContain(
      "import { CreateContactUseCase } from './use-cases/create-contact.use-case';",
    );
    expect(output).toContain(
      "import { UpdateContactUseCase } from './use-cases/update-contact.use-case';",
    );
    expect(output).toContain(
      "import { DeleteContactUseCase } from './use-cases/delete-contact.use-case';",
    );
    expect(output).toContain(
      "import type { CreateContactDto } from './dto/create-contact.dto';",
    );
    expect(output).toContain(
      "import type { UpdateContactDto } from './dto/update-contact.dto';",
    );

    // Constructor injections
    expect(output).toContain(
      'private readonly createUseCase: CreateContactUseCase,',
    );
    expect(output).toContain(
      'private readonly updateUseCase: UpdateContactUseCase,',
    );
    expect(output).toContain(
      'private readonly deleteUseCase: DeleteContactUseCase,',
    );

    // Routes
    expect(output).toContain('@Post()');
    expect(output).toContain(
      'async create(@Body() dto: CreateContactDto): Promise<Contact>',
    );
    expect(output).toContain('return this.createUseCase.execute(dto);');
    expect(output).toContain("@Patch(':id')");
    expect(output).toContain('return this.updateUseCase.execute(id, dto);');
    expect(output).toContain("@Delete(':id')");
    expect(output).toContain('return this.deleteUseCase.execute(id);');

    // No TODO hand-writing scaffolding left behind
    expect(output).not.toContain('TODO: Add write routes');
    expect(output).not.toContain('TODO: inject hand-written write use cases');
  });

  it('omits write imports, injections, and routes when generate.writes is false', () => {
    const def = { ...baseEntity, generate: { writes: false } };
    const locals = buildCleanLitePsLocals(def, {});
    const output = render('controller.ejs.t', locals);

    // No write route imports or decorators
    expect(output).not.toContain('create-contact.use-case');
    expect(output).not.toContain('update-contact.use-case');
    expect(output).not.toContain('delete-contact.use-case');
    expect(output).not.toContain('@Post()');
    expect(output).not.toContain('@Patch');
    expect(output).not.toContain('@Delete');
    expect(output).not.toContain('CreateContactDto');
    expect(output).not.toContain('UpdateContactDto');

    // And no orphaned TODO stubs either
    expect(output).not.toContain('TODO: Add write routes');

    // Read routes still present
    expect(output).toContain('@Get()');
    expect(output).toContain("@Get(':id')");
  });
});

describe('clean-lite-ps write templates — module rendering', () => {
  it('registers write use cases as providers by default', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('module.ejs.t', locals);

    expect(output).toContain(
      "import { CreateContactUseCase } from './use-cases/create-contact.use-case';",
    );
    expect(output).toContain(
      "import { UpdateContactUseCase } from './use-cases/update-contact.use-case';",
    );
    expect(output).toContain(
      "import { DeleteContactUseCase } from './use-cases/delete-contact.use-case';",
    );
    expect(output).toContain('CreateContactUseCase,');
    expect(output).toContain('UpdateContactUseCase,');
    expect(output).toContain('DeleteContactUseCase,');
  });

  it('omits write use-case providers when generate.writes is false', () => {
    const def = { ...baseEntity, generate: { writes: false } };
    const locals = buildCleanLitePsLocals(def, {});
    const output = render('module.ejs.t', locals);

    expect(output).not.toContain('CreateContactUseCase');
    expect(output).not.toContain('UpdateContactUseCase');
    expect(output).not.toContain('DeleteContactUseCase');
  });
});
