/**
 * EVT-7 — Template rendering tests for the typed-emits path.
 *
 * Verifies:
 * - Clean Architecture create/update/delete command templates emit
 *   TYPED_EVENT_BUS wiring and publish() inside a transaction when
 *   hasEmits + <op>EventType are set.
 * - The non-emits path still renders the original (non-transactional)
 *   body — this is the byte-stability guardrail enforced in unit form.
 * - CLP update/delete use-case templates also render the emits body in
 *   non-EAV + non-EAV branches.
 * - The repository-interface template appends tx?: DrizzleTransaction to
 *   the three CRUD signatures when the corresponding EventType is set.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ejs from 'ejs';

const BACKEND_ROOT = resolve(
  import.meta.dir,
  '../../../templates/entity/new/backend',
);
const CLP_ROOT = resolve(
  import.meta.dir,
  '../../../templates/entity/new/clean-lite-ps',
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

function renderFrom(root: string, rel: string, locals: Record<string, unknown>): string {
  const body = extractBody(readFileSync(resolve(root, rel), 'utf8'));
  return ejs.render(body, locals, { rmWhitespace: false });
}

// ---------------------------------------------------------------------------
// Shared fixture locals
// ---------------------------------------------------------------------------

function cleanArchBase() {
  return {
    // Entity identity
    name: 'contact',
    camelName: 'contact',
    className: 'Contact',
    classNamePlural: 'Contacts',
    plural: 'contacts',

    // Output paths (only the ones the three command templates use)
    outputPaths: {
      createCommand: 'src/application/commands/create-contact.command.ts',
      updateCommand: 'src/application/commands/update-contact.command.ts',
      deleteCommand: 'src/application/commands/delete-contact.command.ts',
      repositoryInterface: 'src/domain/contact.repository.interface.ts',
    },
    isCleanArchitecture: true,

    // Generation flags
    generate: { commands: true },

    // Naming — command class names + repo token + imports
    createCommandClass: 'CreateContactCommand',
    updateCommandClass: 'UpdateContactCommand',
    deleteCommandClass: 'DeleteContactCommand',
    repositoryToken: 'CONTACT_REPOSITORY',
    imports: {
      constants: '../../../shared/constants/tokens',
      domain: '../../domain',
      schemas: '../schemas',
    },

    // Fields shape used by the update input mapper
    fields: [
      { name: 'first_name', camelName: 'firstName', required: true, nullable: false },
      { name: 'email', camelName: 'email', required: true, nullable: false },
    ],

    // EVT-7 locals
    hasEmits: false,
    createEventType: null,
    updateEventType: null,
    deleteEventType: null,
    eventsTokenImport: '@shared/subsystems/events',
    drizzleTokenImport: '@shared/constants/tokens',
    drizzleTypeImport: '@shared/types/drizzle',
    tenantContextImport: '@shared/base-classes/tenant-context',

    // Repository-interface extras
    hasEntityRefFields: false,
    hasRelationships: false,
    hasSoftDelete: false,
    hasDeclarativeQueries: false,
    belongsToRelations: [],
    entityRefFields: [],
    processedQueries: [],
  };
}

function withCreateEmit(locals: ReturnType<typeof cleanArchBase>) {
  return {
    ...locals,
    hasEmits: true,
    createEventType: {
      type: 'contact_created',
      aggregate: 'contact',
      payloadMap: [
        { snakeKey: 'contact_id', camelKey: 'contactId', expression: 'entity.id' },
        {
          snakeKey: 'account_id',
          camelKey: 'accountId',
          expression: 'entity.accountId',
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Clean Architecture — create/update/delete commands
// ---------------------------------------------------------------------------

describe('EVT-7 Clean Architecture — create command template', () => {
  it('renders the non-transactional body when hasEmits is false', () => {
    const output = renderFrom(
      BACKEND_ROOT,
      'application/commands/create.ejs.t',
      cleanArchBase(),
    );
    expect(output).toContain('export class CreateContactCommand');
    expect(output).toContain(
      'const created = await this.contactRepository.create(input);',
    );
    expect(output).not.toContain('TYPED_EVENT_BUS');
    expect(output).not.toContain('this.db.transaction');
    expect(output).not.toContain('typedEvents.publish');
  });

  it('wraps the write in a transaction and publishes the typed event when hasEmits + createEventType are set', () => {
    const locals = withCreateEmit(cleanArchBase());
    const output = renderFrom(
      BACKEND_ROOT,
      'application/commands/create.ejs.t',
      locals,
    );
    expect(output).toContain(
      "import { TYPED_EVENT_BUS, TypedEventBus } from '@shared/subsystems/events';",
    );
    expect(output).toContain(
      "import { DRIZZLE } from '@shared/constants/tokens';",
    );
    expect(output).toContain(
      "import type { DrizzleClient } from '@shared/types/drizzle';",
    );
    expect(output).toContain('return this.db.transaction(async (tx) => {');
    expect(output).toContain(
      'const entity = await this.contactRepository.create(input, tx);',
    );
    expect(output).toContain("await this.typedEvents.publish(");
    expect(output).toContain("'contact_created'");
    expect(output).toContain('contactId: entity.id,');
    expect(output).toContain('accountId: entity.accountId,');
    // ADR-043 §5: actor derived from the ambient RequesterContext (ALS).
    expect(output).toContain("import { tryGetRequester } from '@shared/base-classes/tenant-context';");
    expect(output).toContain('const requester = tryGetRequester();');
    expect(output).toContain('tx,');
    expect(output).toContain('metadata: requester ? { userId: requester.userId } : undefined');
    expect(output).not.toContain('opts.actor');
  });
});

describe('EVT-7 Clean Architecture — update command template', () => {
  it('preserves the pre-EVT-7 body when hasEmits is false', () => {
    const output = renderFrom(
      BACKEND_ROOT,
      'application/commands/update.ejs.t',
      cleanArchBase(),
    );
    expect(output).toContain('export class UpdateContactCommand');
    expect(output).toContain(
      'const updated = await this.contactRepository.update(id, input);',
    );
    expect(output).not.toContain('TYPED_EVENT_BUS');
    expect(output).not.toContain('this.db.transaction');
  });

  it('emits typed event inside transaction when hasEmits + updateEventType are set', () => {
    const locals = {
      ...cleanArchBase(),
      hasEmits: true,
      updateEventType: {
        type: 'contact_updated',
        aggregate: 'contact',
        payloadMap: [
          { snakeKey: 'contact_id', camelKey: 'contactId', expression: 'entity.id' },
        ],
      },
    };
    const output = renderFrom(
      BACKEND_ROOT,
      'application/commands/update.ejs.t',
      locals,
    );
    expect(output).toContain(
      "import { TYPED_EVENT_BUS, TypedEventBus } from '@shared/subsystems/events';",
    );
    expect(output).toContain('return this.db.transaction(async (tx) => {');
    expect(output).toContain(
      'const entity = await this.contactRepository.update(id, input, tx);',
    );
    expect(output).toContain("'contact_updated'");
    expect(output).toContain('contactId: entity.id,');
    // ADR-043 §5: actor derived from the ambient RequesterContext (ALS).
    expect(output).toContain('const requester = tryGetRequester();');
    expect(output).toContain('tx,');
    expect(output).toContain('metadata: requester ? { userId: requester.userId } : undefined');
    expect(output).not.toContain('opts.actor');
  });
});

describe('EVT-7 Clean Architecture — delete command template', () => {
  it('preserves the pre-EVT-7 body when hasEmits is false', () => {
    const output = renderFrom(
      BACKEND_ROOT,
      'application/commands/delete.ejs.t',
      cleanArchBase(),
    );
    expect(output).toContain('export class DeleteContactCommand');
    expect(output).toContain(
      'const deleted = await this.contactRepository.delete(id);',
    );
    expect(output).not.toContain('TYPED_EVENT_BUS');
    expect(output).not.toContain('this.db.transaction');
  });

  it('emits typed event inside transaction when hasEmits + deleteEventType are set', () => {
    const locals = {
      ...cleanArchBase(),
      hasEmits: true,
      deleteEventType: {
        type: 'contact_deleted',
        aggregate: 'contact',
        payloadMap: [
          { snakeKey: 'contact_id', camelKey: 'contactId', expression: 'entity.id' },
        ],
      },
    };
    const output = renderFrom(
      BACKEND_ROOT,
      'application/commands/delete.ejs.t',
      locals,
    );
    expect(output).toContain(
      "import { TYPED_EVENT_BUS, TypedEventBus } from '@shared/subsystems/events';",
    );
    expect(output).toContain('return this.db.transaction(async (tx) => {');
    expect(output).toContain(
      'const entity = await this.contactRepository.delete(id, tx);',
    );
    expect(output).toContain("'contact_deleted'");
    expect(output).toContain('contactId: entity.id,');
    // ADR-043 §5: actor derived from the ambient RequesterContext (ALS).
    expect(output).toContain('const requester = tryGetRequester();');
    expect(output).toContain('tx,');
    expect(output).toContain('metadata: requester ? { userId: requester.userId } : undefined');
    expect(output).not.toContain('opts.actor');
  });
});

// ---------------------------------------------------------------------------
// Clean Architecture — repository interface
// ---------------------------------------------------------------------------

describe('EVT-7 Clean Architecture — repository-interface template', () => {
  it('does not append DrizzleTransaction when no emit events are declared', () => {
    const output = renderFrom(
      BACKEND_ROOT,
      'domain/repository-interface.ejs.t',
      cleanArchBase(),
    );
    expect(output).not.toContain('DrizzleTransaction');
    expect(output).toContain(
      'create(input: CreateContactInput): Promise<Contact>;',
    );
    expect(output).toContain(
      'update(id: string, input: UpdateContactInput): Promise<Contact | null>;',
    );
    expect(output).toContain('delete(id: string): Promise<Contact | null>;');
  });

  it('adds tx?: DrizzleTransaction only to the signatures whose event is declared', () => {
    const locals = {
      ...cleanArchBase(),
      hasEmits: true,
      createEventType: { type: 'contact_created', aggregate: 'contact', payloadMap: [] },
      // update has NO event → its signature must NOT take tx
      updateEventType: null,
      deleteEventType: { type: 'contact_deleted', aggregate: 'contact', payloadMap: [] },
    };
    const output = renderFrom(
      BACKEND_ROOT,
      'domain/repository-interface.ejs.t',
      locals,
    );
    expect(output).toContain(
      "import type { DrizzleTransaction } from '@shared/subsystems/events';",
    );
    expect(output).toContain(
      'create(input: CreateContactInput, tx?: DrizzleTransaction): Promise<Contact>;',
    );
    expect(output).toContain(
      'update(id: string, input: UpdateContactInput): Promise<Contact | null>;',
    );
    expect(output).not.toContain(
      'update(id: string, input: UpdateContactInput, tx?:',
    );
    expect(output).toContain(
      'delete(id: string, tx?: DrizzleTransaction): Promise<Contact | null>;',
    );
  });
});

// ---------------------------------------------------------------------------
// CLP — non-EAV create/update/delete use cases
// ---------------------------------------------------------------------------

function clpBase() {
  return {
    entityName: 'contact',
    entityNamePlural: 'contacts',
    classNames: {
      entity: 'Contact',
      service: 'ContactService',
      createDto: 'CreateContactDto',
      updateDto: 'UpdateContactDto',
      createUseCase: 'CreateContactUseCase',
      updateUseCase: 'UpdateContactUseCase',
      deleteUseCase: 'DeleteContactUseCase',
    },
    clpOutputPaths: {
      createUseCase: 'src/modules/contacts/use-cases/create-contact.use-case.ts',
      updateUseCase: 'src/modules/contacts/use-cases/update-contact.use-case.ts',
      deleteUseCase: 'src/modules/contacts/use-cases/delete-contact.use-case.ts',
    },
    eavEnabled: false,
    // EVT-7 locals
    hasEmits: false,
    createEventType: null,
    updateEventType: null,
    deleteEventType: null,
    eventsTokenImport: '@shared/subsystems/events',
    drizzleTokenImport: '@shared/constants/tokens',
    drizzleTypeImport: '@shared/types/drizzle',
    tenantContextImport: '@shared/base-classes/tenant-context',
  };
}

describe('EVT-7 CLP — non-EAV use-case templates', () => {
  it('create.ejs.t: non-emits path is unchanged (one-line service delegate)', () => {
    const output = renderFrom(CLP_ROOT, 'use-cases/create.ejs.t', clpBase());
    expect(output).toContain('export class CreateContactUseCase');
    expect(output).toContain('return this.service.create(dto);');
    expect(output).not.toContain('TYPED_EVENT_BUS');
  });

  it('create.ejs.t: emits-path wraps the service call in a db.transaction and publishes', () => {
    const locals = {
      ...clpBase(),
      hasEmits: true,
      createEventType: {
        type: 'contact_created',
        aggregate: 'contact',
        payloadMap: [
          { snakeKey: 'contact_id', camelKey: 'contactId', expression: 'entity.id' },
        ],
      },
    };
    const output = renderFrom(CLP_ROOT, 'use-cases/create.ejs.t', locals);
    expect(output).toContain(
      "import { TYPED_EVENT_BUS, TypedEventBus } from '@shared/subsystems/events';",
    );
    expect(output).toContain(
      "import { DRIZZLE } from '@shared/constants/tokens';",
    );
    expect(output).toContain('return this.db.transaction(async (tx) => {');
    expect(output).toContain('const entity = await this.service.create(dto, tx);');
    expect(output).toContain("await this.typedEvents.publish(");
    expect(output).toContain("'contact_created'");
    expect(output).toContain('contactId: entity.id,');
  });

  it('delete.ejs.t: emits-path fetches, deletes, then publishes inside a transaction', () => {
    const locals = {
      ...clpBase(),
      hasEmits: true,
      deleteEventType: {
        type: 'contact_deleted',
        aggregate: 'contact',
        payloadMap: [
          { snakeKey: 'contact_id', camelKey: 'contactId', expression: 'entity.id' },
        ],
      },
    };
    const output = renderFrom(CLP_ROOT, 'use-cases/delete.ejs.t', locals);
    expect(output).toContain('export class DeleteContactUseCase');
    expect(output).toContain('NotFoundException');
    expect(output).toContain('const entity = await this.service.findById(id);');
    expect(output).toContain('await this.service.delete(id, tx);');
    expect(output).toContain("'contact_deleted'");
  });
});
