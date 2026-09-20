/**
 * EVT-7 — Template rendering tests for the typed-emits path.
 *
 * Verifies:
 * - The backend create/delete use-case templates emit TYPED_EVENT_BUS wiring and
 *   publish() inside a transaction when hasEmits + <op>EventType are set.
 * - The non-emits path still renders the original (non-transactional)
 *   body — this is the byte-stability guardrail enforced in unit form.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ejs from 'ejs';
import { withEntities } from '../backend/_entity-lookup';

const BACKEND_ROOT = resolve(
  import.meta.dir,
  '../../../templates/entity/new/backend',
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
// backend — non-EAV create/update/delete use cases
// ---------------------------------------------------------------------------

function base() {
  // The prompt-owned locals (banner, `@shared/*` runtime import specifiers,
  // EVT-7 defaults) come from the shared test base (#638).
  return {
    ...withEntities(),
    entityName: 'contact',
    entityFileStem: 'contact',
    entityNamePlural: 'contacts',
    entityPluralFileStem: 'contacts',
    classNames: {
      entity: 'Contact',
      service: 'ContactService',
      createDto: 'CreateContactDto',
      updateDto: 'UpdateContactDto',
      createUseCase: 'CreateContactUseCase',
      updateUseCase: 'UpdateContactUseCase',
      deleteUseCase: 'DeleteContactUseCase',
    },
    outputPaths: {
      createUseCase: 'src/modules/contacts/use-cases/create-contact.use-case.ts',
      updateUseCase: 'src/modules/contacts/use-cases/update-contact.use-case.ts',
      deleteUseCase: 'src/modules/contacts/use-cases/delete-contact.use-case.ts',
    },
    eavEnabled: false,
  };
}

describe('EVT-7 backend — non-EAV use-case templates', () => {
  it('create.ejs.t: non-emits path is unchanged (one-line service delegate)', () => {
    const output = renderFrom(BACKEND_ROOT, 'use-cases/create.ejs.t', base());
    expect(output).toContain('export class CreateContactUseCase');
    expect(output).toContain('return this.service.create(dto);');
    expect(output).not.toContain('TYPED_EVENT_BUS');
  });

  it('create.ejs.t: emits-path wraps the service call in a db.transaction and publishes', () => {
    const locals = {
      ...base(),
      hasEmits: true,
      createEventType: {
        type: 'contact_created',
        aggregate: 'contact',
        payloadMap: [
          { snakeKey: 'contact_id', camelKey: 'contactId', expression: 'entity.id' },
        ],
      },
    };
    const output = renderFrom(BACKEND_ROOT, 'use-cases/create.ejs.t', locals);
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
      ...base(),
      hasEmits: true,
      deleteEventType: {
        type: 'contact_deleted',
        aggregate: 'contact',
        payloadMap: [
          { snakeKey: 'contact_id', camelKey: 'contactId', expression: 'entity.id' },
        ],
      },
    };
    const output = renderFrom(BACKEND_ROOT, 'use-cases/delete.ejs.t', locals);
    expect(output).toContain('export class DeleteContactUseCase');
    expect(output).toContain('NotFoundException');
    expect(output).toContain('const entity = await this.service.findById(id);');
    expect(output).toContain('await this.service.delete(id, tx);');
    expect(output).toContain("'contact_deleted'");
  });
});
