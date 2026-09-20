/**
 * Template rendering tests for backend EAV (`eav: true`) emission.
 *
 * Verifies:
 * - prompt-extension exposes findByIdWithFields / listWithFields use-case
 *   class names and output paths, gated by `eav: true`
 * - Paired read templates render correctly
 * - Compound-write templates (create/update) switch to transactional shape
 *   when eav is enabled, calling FieldValueService.upsertFieldsTransactional
 * - Controller gates GET /with-fields + GET /:id/with-fields on eav
 * - Service injects FieldValueService and emits paired read methods calling
 *   FieldValueService.findMergedByEntity
 * - Module imports FieldValuesModule and registers the paired use cases
 * - `eav` default (false) preserves the pre-existing non-EAV shape
 *
 * Contract: when eav:true, the generated code never reaches into
 * FieldValueRepository or FieldDefinitionRepository directly. All EAV
 * operations go through FieldValueService which owns the map resolution.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ejs from 'ejs';
import { buildBackendLocals } from '../../../templates/entity/new/backend/entity-locals.js';
import { withEntities } from './_entity-lookup';
import { entityLookupFrom } from '../../../templates/_shared/entity-naming.mjs';

const TEMPLATE_ROOT = resolve(
  import.meta.dir,
  '../../../templates/entity/new/backend',
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
    name: 'opportunity',
    plural: 'opportunities',
    table: 'opportunities',
    pattern: 'Integrated',
  },
  fields: {
    name: { type: 'string', required: true },
  },
  relationships: {},
  behaviors: ['timestamps'],
};

const eavEntity = { ...baseEntity, eav: true };

describe('backend eav templates — prompt-extension wiring', () => {
  it('exposes paired read use-case class names', () => {
    const locals = buildBackendLocals(eavEntity, withEntities());

    expect(locals.eavEnabled).toBe(true);
    expect(locals.classNames.findByIdWithFieldsUseCase).toBe(
      'FindOpportunityByIdWithFieldsUseCase',
    );
    expect(locals.classNames.listWithFieldsUseCase).toBe(
      'ListOpportunitiesWithFieldsUseCase',
    );
  });

  it('exposes paired read output paths when eav is true', () => {
    const locals = buildBackendLocals(eavEntity, withEntities());

    expect(locals.outputPaths.findByIdWithFieldsUseCase).toBe(
      'src/modules/opportunities/use-cases/find-opportunity-by-id-with-fields.use-case.ts',
    );
    expect(locals.outputPaths.listWithFieldsUseCase).toBe(
      'src/modules/opportunities/use-cases/list-opportunities-with-fields.use-case.ts',
    );
  });

  it('nulls paired read output paths when eav is omitted (default)', () => {
    const locals = buildBackendLocals(baseEntity, withEntities());

    expect(locals.eavEnabled).toBe(false);
    expect(locals.outputPaths.findByIdWithFieldsUseCase).toBeNull();
    expect(locals.outputPaths.listWithFieldsUseCase).toBeNull();
  });
});

describe('backend eav templates — paired read use cases', () => {
  it('find-by-id-with-fields delegates to service.findByIdWithFields', () => {
    const locals = buildBackendLocals(eavEntity, withEntities());
    const output = render('use-cases/find-by-id-with-fields.ejs.t', locals);

    expect(output).toContain('export class FindOpportunityByIdWithFieldsUseCase');
    expect(output).toContain(
      "import { OpportunityService } from '../opportunity.service';",
    );
    expect(output).toContain(
      '(Opportunity & { fields: Record<string, unknown> }) | null',
    );
    expect(output).toContain('return this.service.findByIdWithFields(id);');
  });

  it('list-with-fields delegates to service.listWithFields', () => {
    const locals = buildBackendLocals(eavEntity, withEntities());
    const output = render('use-cases/list-with-fields.ejs.t', locals);

    expect(output).toContain('export class ListOpportunitiesWithFieldsUseCase');
    expect(output).toContain(
      'Array<Opportunity & { fields: Record<string, unknown> }>',
    );
    expect(output).toContain('return this.service.listWithFields();');
  });
});

describe('backend eav templates — compound-write use cases', () => {
  it('create.ejs.t emits the transactional compound-write shape when eav is true', () => {
    const locals = buildBackendLocals(eavEntity, withEntities());
    const output = render('use-cases/create.ejs.t', locals);

    // Imports — EAV-specific plumbing.
    expect(output).toContain("import { DRIZZLE } from '@shared/constants/tokens';");
    expect(output).toContain("import type { DrizzleClient } from '@shared/types/drizzle';");
    expect(output).toContain(
      "import { FieldValueService } from '../../field-values/field-value.service';",
    );

    // Constructor composes entity service + FieldValueService + DRIZZLE_DB.
    expect(output).toContain('private readonly opportunities: OpportunityService,');
    expect(output).toContain('private readonly fields: FieldValueService,');
    expect(output).toContain('@Inject(DRIZZLE) private readonly db: DrizzleClient,');

    // Execute body splits { fields, ...core } and runs in a tx.
    expect(output).toContain('this.db.transaction(async (tx) =>');
    expect(output).toContain('const { fields, ...core } = dto;');
    expect(output).toContain(
      'const entity = await this.opportunities.create(core as CreateOpportunityDto, tx);',
    );

    // Calls the service-level compound helper — NOT toEavRows / upsertMany.
    expect(output).toContain('this.fields.upsertFieldsTransactional(');
    expect(output).toContain("'opportunity',");
    expect(output).toContain('entity.id,');
    expect(output).toContain('core.userId,');
    expect(output).toContain('fields,');
    expect(output).toContain('tx,');

    // No direct helper imports or repository injection.
    expect(output).not.toContain('toEavRows');
    expect(output).not.toContain('upsertMany');
    expect(output).not.toContain('FieldValueRepository');
    expect(output).not.toContain('FieldDefinitionRepository');
  });

  it('create.ejs.t preserves the one-line shape when eav is false', () => {
    const locals = buildBackendLocals(baseEntity, withEntities());
    const output = render('use-cases/create.ejs.t', locals);

    expect(output).toContain('return this.service.create(dto);');
    expect(output).not.toContain('transaction');
    expect(output).not.toContain('FieldValueService');
    expect(output).not.toContain('DRIZZLE');
  });

  it('update.ejs.t emits the transactional compound-write shape when eav is true', () => {
    const locals = buildBackendLocals(eavEntity, withEntities());
    const output = render('use-cases/update.ejs.t', locals);

    expect(output).toContain(
      'dto: UpdateOpportunityDto & { fields?: Record<string, unknown> },',
    );
    expect(output).toContain(
      'const entity = await this.opportunities.update(id, core as UpdateOpportunityDto, tx);',
    );
    expect(output).toContain('if (!entity) return null;');

    // Update reads userId from the loaded entity (update DTO omits userId).
    expect(output).toContain('this.fields.upsertFieldsTransactional(');
    expect(output).toContain('entity.userId,');

    expect(output).not.toContain('toEavRows');
    expect(output).not.toContain('upsertMany');
  });

  it('update.ejs.t preserves the one-line shape when eav is false', () => {
    const locals = buildBackendLocals(baseEntity, withEntities());
    const output = render('use-cases/update.ejs.t', locals);

    expect(output).toContain('return this.service.update(id, dto);');
    expect(output).not.toContain('transaction');
    expect(output).not.toContain('FieldValueService');
  });
});

describe('backend eav templates — service rendering', () => {
  it('injects FieldValueService and emits paired read methods when eav is true', () => {
    const locals = buildBackendLocals(eavEntity, withEntities());
    const output = render('service.ejs.t', locals);

    expect(output).toContain(
      "import { FieldValueService } from '../field-values/field-value.service';",
    );
    expect(output).toContain('private readonly fieldValues: FieldValueService,');
    expect(output).toContain('async findByIdWithFields(');
    expect(output).toContain('async listWithFields(');

    // Paired reads go through FieldValueService.findMergedByEntity — NOT
    // directly through FieldValueRepository or FieldDefinitionRepository.
    expect(output).toContain(
      "await this.fieldValues.findMergedByEntity('opportunity', id);",
    );
    expect(output).toContain(
      "await this.fieldValues.findMergedByEntity('opportunity', entity.id);",
    );

    expect(output).not.toContain('FieldValueRepository');
    expect(output).not.toContain('FieldDefinitionRepository');
    expect(output).not.toContain('mergeEavRows');
    expect(output).not.toContain('findByEntityIdAndType');
  });

  it('omits EAV wiring when eav is false (default)', () => {
    const locals = buildBackendLocals(baseEntity, withEntities());
    const output = render('service.ejs.t', locals);

    expect(output).not.toContain('FieldValueService');
    expect(output).not.toContain('findMergedByEntity');
    expect(output).not.toContain('findByIdWithFields');
    expect(output).not.toContain('listWithFields');
  });
});

describe('backend eav templates — controller rendering', () => {
  it('adds GET /with-fields + GET /:id/with-fields routes when eav is true', () => {
    const locals = buildBackendLocals(eavEntity, withEntities());
    const output = render('controller.ejs.t', locals);

    expect(output).toContain(
      "import { FindOpportunityByIdWithFieldsUseCase } from './use-cases/find-opportunity-by-id-with-fields.use-case';",
    );
    expect(output).toContain(
      "import { ListOpportunitiesWithFieldsUseCase } from './use-cases/list-opportunities-with-fields.use-case';",
    );
    expect(output).toContain(
      'private readonly findByIdWithFieldsUseCase: FindOpportunityByIdWithFieldsUseCase,',
    );
    expect(output).toContain(
      'private readonly listWithFieldsUseCase: ListOpportunitiesWithFieldsUseCase,',
    );
    expect(output).toContain("@Get('with-fields')");
    expect(output).toContain("@Get(':id/with-fields')");
    expect(output).toContain('return this.listWithFieldsUseCase.execute();');
    expect(output).toContain('const entity = await this.findByIdWithFieldsUseCase.execute(id);');
    expect(output).toContain('throw new NotFoundException');

    // Ordering: static /with-fields route must be declared before the :id
    // param route so NestJS doesn't capture "with-fields" as an id.
    const withFieldsIdx = output.indexOf("@Get('with-fields')");
    const byIdIdx = output.indexOf("@Get(':id')");
    expect(withFieldsIdx).toBeGreaterThan(-1);
    expect(byIdIdx).toBeGreaterThan(-1);
    expect(withFieldsIdx).toBeLessThan(byIdIdx);
  });

  it('omits EAV routes when eav is false (default)', () => {
    const locals = buildBackendLocals(baseEntity, withEntities());
    const output = render('controller.ejs.t', locals);

    expect(output).not.toContain('with-fields');
    expect(output).not.toContain('FindOpportunityByIdWithFieldsUseCase');
    expect(output).not.toContain('ListOpportunitiesWithFieldsUseCase');
  });
});

describe('backend eav templates — module rendering', () => {
  it('imports FieldValuesModule and registers paired use cases when eav is true', () => {
    const locals = buildBackendLocals(eavEntity, withEntities());
    const output = render('module.ejs.t', locals);

    expect(output).toContain(
      "import { FieldValuesModule } from '../field-values/field-values.module';",
    );
    expect(output).toContain(
      "import { FindOpportunityByIdWithFieldsUseCase } from './use-cases/find-opportunity-by-id-with-fields.use-case';",
    );
    expect(output).toContain(
      "import { ListOpportunitiesWithFieldsUseCase } from './use-cases/list-opportunities-with-fields.use-case';",
    );
    expect(output).toContain('FieldValuesModule,');
    expect(output).toContain('FindOpportunityByIdWithFieldsUseCase,');
    expect(output).toContain('ListOpportunitiesWithFieldsUseCase,');
  });

  it('omits EAV wiring when eav is false (default)', () => {
    const locals = buildBackendLocals(baseEntity, withEntities());
    const output = render('module.ejs.t', locals);

    expect(output).not.toContain('FieldValuesModule');
    expect(output).not.toContain('WithFieldsUseCase');
  });
});

describe('backend eav templates — composition with generate.writes', () => {
  it('suppresses compound writes but keeps paired reads when writes:false + eav:true', () => {
    const def = { ...eavEntity, generate: { writes: false } };
    const locals = buildBackendLocals(def, withEntities());

    expect(locals.generateWrites).toBe(false);
    expect(locals.eavEnabled).toBe(true);
    expect(locals.outputPaths.createUseCase).toBeNull();
    expect(locals.outputPaths.updateUseCase).toBeNull();
    expect(locals.outputPaths.deleteUseCase).toBeNull();
    expect(locals.outputPaths.findByIdWithFieldsUseCase).not.toBeNull();
    expect(locals.outputPaths.listWithFieldsUseCase).not.toBeNull();
  });
});

describe('backend eav templates — field-value entity named from its YAML (#647)', () => {
  // Both sides carry a `context:` and the field-value entity declares its own
  // `plural:` — a hand-built '../field_values/' resolves nowhere here.
  const contextEav = {
    ...eavEntity,
    entity: { ...eavEntity.entity, context: 'sales' },
  };
  const locals = () => ({
    ...buildBackendLocals(contextEav, {
      ...withEntities(),
      entityLookup: entityLookupFrom([
        { name: 'field_value', plural: 'custom_field_values', context: 'eav' },
      ]),
    }),
  });

  it('service and repository import FieldValueService from the resolved folder', () => {
    const l = locals();
    for (const tpl of ['service.ejs.t', 'repository.ejs.t']) {
      expect(render(tpl, l)).toContain(
        "import { FieldValueService } from '../../eav/custom-field-values/field-value.service';",
      );
    }
  });

  it('create / update use cases import FieldValueService one level deeper', () => {
    const l = locals();
    for (const tpl of ['use-cases/create.ejs.t', 'use-cases/update.ejs.t']) {
      expect(render(tpl, l)).toContain(
        "import { FieldValueService } from '../../../eav/custom-field-values/field-value.service';",
      );
    }
  });

  it('module imports the field-value module by its plural', () => {
    const output = render('module.ejs.t', locals());
    expect(output).toContain(
      "import { CustomFieldValuesModule } from '../../eav/custom-field-values/custom-field-values.module';",
    );
    expect(output).toContain('CustomFieldValuesModule,');
    expect(output).not.toContain('field-values/field-values.module');
  });

  it('a missing field_value YAML is a generation error', () => {
    expect(() =>
      buildBackendLocals(contextEav, { ...withEntities(), entityLookup: entityLookupFrom([]) }),
    ).toThrow(/references 'field_value', which has no entity YAML/);
  });
});
