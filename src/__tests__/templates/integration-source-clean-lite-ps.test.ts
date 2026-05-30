/**
 * Issue #267 + ADR-033.1 §8 — clean-lite-ps integration-source emission.
 *
 * The integration-source.ejs.t template's `to:` and entity-import paths must route
 * through clean-lite-ps overrides when the architecture is `clean-lite-ps`:
 *   - module emit path: src/modules/<plural>/<entity>-integration-source.module.ts
 *     (co-located with the entity file, NOT under infrastructure/modules/)
 *   - entity import: ./<entity>.entity (sibling import, matches the
 *     entity-file location in the same feature folder)
 *
 * Both are sourced from `clpOutputPaths.integrationSourceModule` and
 * `clpImports.integrationSourceToEntity` populated by the clean-lite-ps
 * prompt-extension.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ejs from 'ejs';
import { buildCleanLitePsLocals } from '../../../templates/entity/new/clean-lite-ps/prompt-extension.js';

const MODULE_TEMPLATE = resolve(
  import.meta.dir,
  '../../../templates/entity/new/backend/modules/core/integration-source.ejs.t',
);
const PROVIDERS_TEMPLATE = resolve(
  import.meta.dir,
  '../../../templates/entity/new/backend/modules/core/integration-source.providers.ejs.t',
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

describe('integration-source emission (clean-lite-ps) — #267', () => {
  it('clean-lite-ps locals expose integrationSourceModule + integrationSourceProviders + clpImports.integrationSourceToEntity', () => {
    const locals = buildCleanLitePsLocals(opportunityDefinition, { backendSrc: 'src' });

    expect(locals.clpOutputPaths.integrationSourceModule).toBe(
      'src/modules/opportunities/opportunity-integration-source.module.ts',
    );
    expect(locals.clpOutputPaths.integrationSourceProviders).toBe(
      'src/modules/opportunities/opportunity-integration-source.providers.ts',
    );
    expect(locals.clpImports.integrationSourceToEntity).toBe('./opportunity.entity');
  });

  it('module template `to:` resolves to the CLP path when isCleanLitePs is true', () => {
    const locals = buildCleanLitePsLocals(opportunityDefinition, { backendSrc: 'src' });
    const { frontmatter } = readFrontmatter(readFileSync(MODULE_TEMPLATE, 'utf8'));
    // Render the frontmatter as EJS so the conditional ternary evaluates.
    const rendered = ejs.render(frontmatter, {
      hasDetection: true,
      isCleanLitePs: true,
      clpOutputPaths: locals.clpOutputPaths,
      basePaths: { backendSrc: 'unused' },
      paths: { modules: 'unused' },
      name: 'opportunity',
    });
    expect(rendered).toContain('src/modules/opportunities/opportunity-integration-source.module.ts');
    expect(rendered).not.toContain('unused');
  });

  it('providers template `to:` resolves to the CLP path when isCleanLitePs is true', () => {
    const locals = buildCleanLitePsLocals(opportunityDefinition, { backendSrc: 'src' });
    const { frontmatter } = readFrontmatter(readFileSync(PROVIDERS_TEMPLATE, 'utf8'));
    const rendered = ejs.render(frontmatter, {
      hasDetection: true,
      isCleanLitePs: true,
      clpOutputPaths: locals.clpOutputPaths,
      basePaths: { backendSrc: 'unused' },
      paths: { modules: 'unused' },
      name: 'opportunity',
    });
    expect(rendered).toContain('src/modules/opportunities/opportunity-integration-source.providers.ts');
    expect(rendered).not.toContain('unused');
  });

  it('module body imports the entity sibling-style under clean-lite-ps', () => {
    const locals = buildCleanLitePsLocals(opportunityDefinition, { backendSrc: 'src' });
    const { body } = readFrontmatter(readFileSync(MODULE_TEMPLATE, 'utf8'));
    const rendered = ejs.render(body, {
      name: 'opportunity',
      className: 'Opportunity',
      hasDetection: true,
      detectionConfigsLiteral: '{}',
      isCleanLitePs: true,
      clpImports: locals.clpImports,
      imports: { moduleToDomain: '../../domain' },
    });
    expect(rendered).toContain("import type { Opportunity } from './opportunity.entity';");
    expect(rendered).not.toContain("from '../../domain'");
  });

  it('clean-architecture path still uses imports.moduleToDomain (regression guard)', () => {
    const { body } = readFrontmatter(readFileSync(MODULE_TEMPLATE, 'utf8'));
    const rendered = ejs.render(body, {
      name: 'opportunity',
      className: 'Opportunity',
      hasDetection: true,
      detectionConfigsLiteral: '{}',
      isCleanLitePs: false,
      clpImports: undefined,
      imports: { moduleToDomain: '../domain' },
    });
    expect(rendered).toContain("import type { Opportunity } from '../domain';");
  });
});
