/**
 * EVT-7 — Template rendering tests for the typed-emits path.
 *
 * Verifies:
 * - The backend create/delete use-case templates emit TYPED_EVENT_BUS wiring and
 *   publish() inside a transaction when hasEmits + <op>EventType are set.
 * - The non-emits path still renders the original (non-transactional)
 *   body — this is the byte-stability guardrail enforced in unit form.
 * - #814: in package mode the TypedEventBus class is imported from the
 *   project's generated bus, never from the package barrel (which exports the
 *   token only); vendored output keeps its single combined line.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ejs from 'ejs';
import { buildBackendLocals } from '../../../templates/entity/new/backend/entity-locals.js';
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
// Locals
// ---------------------------------------------------------------------------

interface BaseOpts {
  runtimeMode?: 'vendored' | 'package';
  eav?: boolean;
  modulesDir?: string;
  generatedDir?: string;
  context?: string;
}

function eventType(op: string) {
  return {
    type: `contact_${op}d`,
    aggregate: 'contact',
    payloadMap: [{ snakeKey: 'contact_id', camelKey: 'contactId', expression: 'entity.id' }],
  };
}

/**
 * The locals come from `buildBackendLocals` (#638, #814): a hand-built set
 * would need a hand-written `typedEventBusImport`, the test-only fallback #638
 * removed. Only the prompt-owned EVT-7 descriptors are overlaid.
 */
function base(opts: BaseOpts = {}): Record<string, unknown> {
  const definition: any = {
    entity: { name: 'contact', plural: 'contacts', table: 'contacts' },
    fields: { name: { type: 'string', required: true } },
    behaviors: ['timestamps'],
  };
  if (opts.eav) definition.entity.eav = true;
  if (opts.context) definition.entity.context = opts.context;
  const input = withEntities({
    runtimeMode: opts.runtimeMode ?? 'vendored',
    ...(opts.modulesDir ? { modulesDir: opts.modulesDir } : {}),
    ...(opts.generatedDir ? { generatedDir: opts.generatedDir } : {}),
  });
  return {
    ...buildBackendLocals(definition, input),
    hasEmits: true,
    createEventType: eventType('create'),
    updateEventType: eventType('update'),
    deleteEventType: eventType('delete'),
  } as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// backend — non-EAV create/update/delete use cases
// ---------------------------------------------------------------------------

describe('EVT-7 backend — non-EAV use-case templates', () => {
  it('create.ejs.t: non-emits path is unchanged (one-line service delegate)', () => {
    const output = renderFrom(BACKEND_ROOT, 'use-cases/create.ejs.t', {
      ...base(),
      hasEmits: false,
      createEventType: null,
    });
    expect(output).toContain('export class CreateContactUseCase');
    expect(output).toContain('return this.service.create(dto);');
    expect(output).not.toContain('TYPED_EVENT_BUS');
  });

  it('create.ejs.t: emits-path wraps the service call in a db.transaction and publishes', () => {
    const output = renderFrom(BACKEND_ROOT, 'use-cases/create.ejs.t', base());
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
    const output = renderFrom(BACKEND_ROOT, 'use-cases/delete.ejs.t', base());
    expect(output).toContain('export class DeleteContactUseCase');
    expect(output).toContain('NotFoundException');
    expect(output).toContain('const entity = await this.service.findById(id);');
    expect(output).toContain('await this.service.delete(id, tx);');
    expect(output).toContain("'contact_deleted'");
  });
});

// ---------------------------------------------------------------------------
// #814 — the TypedEventBus class comes from the project's generated bus
// ---------------------------------------------------------------------------

const SITES = [
  { name: 'create (non-EAV)', tpl: 'use-cases/create.ejs.t', eav: false },
  { name: 'create (EAV)', tpl: 'use-cases/create.ejs.t', eav: true },
  { name: 'update (non-EAV)', tpl: 'use-cases/update.ejs.t', eav: false },
  { name: 'update (EAV)', tpl: 'use-cases/update.ejs.t', eav: true },
  { name: 'delete', tpl: 'use-cases/delete.ejs.t', eav: false },
];

describe('#814 — TypedEventBus import, package mode', () => {
  it.each(SITES)('$name: token from the barrel, class from the generated bus', ({ tpl, eav }) => {
    const output = renderFrom(BACKEND_ROOT, tpl, base({ runtimeMode: 'package', eav }));
    expect(output).toContain("import { TYPED_EVENT_BUS } from '@pattern-stack/codegen/subsystems';");
    expect(output).toContain("import { TypedEventBus } from '../../../generated/events/bus';");
    expect(output).not.toContain("TypedEventBus } from '@pattern-stack/codegen/subsystems'");
  });

  it('custom layout + context: the specifier follows modules_dir, context and generated', () => {
    const locals = base({
      runtimeMode: 'package',
      modulesDir: 'apps/backend/src/domain',
      generatedDir: 'apps/backend/src/codegen',
      context: 'accounting',
    });
    expect(locals.typedEventBusImport).toBe('../../../../codegen/events/bus');
    const output = renderFrom(BACKEND_ROOT, 'use-cases/create.ejs.t', locals);
    expect(output).toContain("import { TypedEventBus } from '../../../../codegen/events/bus';");
  });
});

describe('#814 — TypedEventBus import, vendored mode', () => {
  it.each(['create', 'update', 'delete'])('%s: one combined line, no second import', (op) => {
    const output = renderFrom(BACKEND_ROOT, `use-cases/${op}.ejs.t`, base());
    expect(output).toContain(
      "import { TYPED_EVENT_BUS, TypedEventBus } from '@shared/subsystems/events';",
    );
    expect(output.match(/import \{[^}]*TypedEventBus[^}]*\}/g)?.length).toBe(1);
  });
});
