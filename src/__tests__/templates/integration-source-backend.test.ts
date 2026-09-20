/**
 * Issue #267 + ADR-033.1 §8 — backend integration-source emission.
 *
 * The integration-source.ejs.t template's `to:` and entity-import paths come
 * from the backend locals (the only backend pipeline, ARCH-0):
 *   - module emit path: src/modules/<plural>/<entity>-integration-source.module.ts
 *     (co-located with the entity file, NOT under infrastructure/modules/)
 *   - entity import: ./<entity>.entity (sibling import, matches the
 *     entity-file location in the same feature folder)
 *
 * Both are sourced from `outputPaths.integrationSourceModule` and
 * `imports.integrationSourceToEntity` populated by the backend
 * prompt-extension.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ejs from 'ejs';
import { buildBackendLocals } from '../../../templates/entity/new/backend/entity-locals.js';
import { withEntities } from '../backend/_entity-lookup';

const MODULE_TEMPLATE = resolve(
  import.meta.dir,
  '../../../templates/entity/new/backend/integration-source.ejs.t',
);
function readFrontmatter(source: string): { frontmatter: string; body: string } {
  const lines = source.split('\n');
  if (lines[0] !== '---') return { frontmatter: '', body: source };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { frontmatter: '', body: source };
  return {
    frontmatter: lines.slice(1, end).join('\n'),
    body: lines.slice(end + 1).join('\n'),
  };
}

const opportunityDefinition = {
  entity: { name: 'opportunity', plural: 'opportunities', table: 'opportunities', pattern: 'Integrated' },
  fields: {
    user_id: { type: 'uuid', required: true },
    name: { type: 'string', required: true },
    amount: { type: 'decimal', nullable: true },
  },
  relationships: {
    user: { type: 'belongs_to', target: 'user', foreign_key: 'user_id', nullable: false },
  },
  behaviors: ['timestamps'],
};

describe('integration-source emission (backend) — #267', () => {
  it('backend locals expose integrationSourceModule + imports.integrationSourceToEntity', () => {
    const locals = buildBackendLocals(opportunityDefinition, withEntities({ modulesDir: 'src/modules' }));

    expect(locals.outputPaths.integrationSourceModule).toBe(
      'src/modules/opportunities/opportunity-integration-source.module.ts',
    );
    // ADR-033.2's per-entity provider tuples are removed (RFC-0001 §8, D4):
    // no `integrationSourceProviders` output path is emitted anymore.
    expect(locals.outputPaths.integrationSourceProviders).toBeUndefined();
    expect(locals.imports.integrationSourceToEntity).toBe('./opportunity.entity');
  });

  it('module template `to:` resolves to the backend path', () => {
    const locals = buildBackendLocals(opportunityDefinition, withEntities({ modulesDir: 'src/modules' }));
    const { frontmatter } = readFrontmatter(readFileSync(MODULE_TEMPLATE, 'utf8'));
    // Render the frontmatter as EJS so the conditional ternary evaluates.
    const rendered = ejs.render(frontmatter, {
      hasDetection: true,
      outputPaths: locals.outputPaths,
    });
    expect(rendered).toContain('src/modules/opportunities/opportunity-integration-source.module.ts');
  });

  // ADR-033.2's per-entity provider-tuple template (integration-source.providers.ejs.t)
  // is deleted by RFC-0001 §8 (D4); its emission test is removed with it. The
  // surface-scoped typed view replaces it (adapter-emission-generator.test.ts).

  it('module body imports the entity sibling-style', () => {
    const locals = buildBackendLocals(opportunityDefinition, withEntities({ modulesDir: 'src/modules' }));
    const { body } = readFrontmatter(readFileSync(MODULE_TEMPLATE, 'utf8'));
    const rendered = ejs.render(body, {
      entityName: 'opportunity',
      classNames: { entity: 'Opportunity' },
      hasDetection: true,
      detectionConfigsLiteral: '{}',
      imports: locals.imports,
      generatedBanner: '// @generated',
      integrationSubsystemImport: '@shared/subsystems/integration',
    });
    expect(rendered).toContain("import type { Opportunity } from './opportunity.entity';");
  });
});
