/**
 * Template rendering tests for backend YAML filter/search query
 * generation (task #16).
 *
 * A `queries: - name: search` block in entity YAML should emit:
 *   - SearchXsUseCase with filter-AND + optional ilike, paged through the
 *     list use case so it returns the list's own `Page<T>` (#744)
 *   - <entity>-search.controller.ts validating the list's `ListQuerySchema`
 *     extended with the filters
 *   - Module wires both into controllers[] and providers[]
 *
 * Entities without a search query keep the existing shape; non-search
 * queries (the by-column form) pass through the union unchanged.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ejs from 'ejs';
import { buildBackendLocals } from '../../../templates/entity/new/backend/entity-locals.js';
import { withEntities } from './_entity-lookup';
import { EntityDefinitionSchema } from '../../schema/entity-definition.schema';

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
  return ejs.render(extractBody(readTemplate(relPath)), locals, { rmWhitespace: false });
}

const baseEntity = {
  entity: { name: 'opportunity', plural: 'opportunities', table: 'opportunities', pattern: 'Integrated' },
  fields: {
    name: { type: 'string', required: true },
    canonical_state: {
      type: 'enum',
      choices: ['qualifying', 'developing', 'proposing', 'negotiating', 'closed_won', 'closed_lost'],
      nullable: true,
    },
    is_closed: { type: 'boolean', required: true, default: false },
    is_won: { type: 'boolean', required: true, default: false },
    provider: { type: 'string', nullable: true },
    user_id: { type: 'uuid', required: true },
  },
  relationships: {
    account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' },
  },
  behaviors: ['timestamps'],
  queries: [
    {
      name: 'search',
      filters: ['user_id', 'account_id', 'canonical_state', 'is_closed', 'is_won', 'provider'],
      search: 'name',
    },
  ],
};

const entityWithoutSearch = { ...baseEntity, queries: undefined };

describe('backend search templates — prompt-extension wiring', () => {
  it('builds searchQuery locals when queries declares a search', () => {
    const locals = buildBackendLocals(baseEntity, withEntities());

    expect(locals.hasSearchQuery).toBe(true);
    expect(locals.searchQuery).not.toBeNull();
    expect(locals.searchQuery.useCaseClassName).toBe('SearchOpportunitiesUseCase');
    expect(locals.searchQuery.filtersSchemaName).toBe('OpportunityFiltersSchema');
    expect(locals.searchQuery.inputTypeName).toBe('SearchOpportunitiesInput');
    expect(locals.searchQuery.searchField).toBe('name');
  });

  it('resolves belongs_to FKs in filters (account_id → isUuid)', () => {
    const locals = buildBackendLocals(baseEntity, withEntities());
    const accountIdFilter = locals.searchQuery.filters.find((f: any) => f.camelName === 'accountId');

    expect(accountIdFilter).toBeDefined();
    expect(accountIdFilter.isUuid).toBe(true);
  });

  it('resolves enum filter with choices', () => {
    const locals = buildBackendLocals(baseEntity, withEntities());
    const enumFilter = locals.searchQuery.filters.find((f: any) => f.camelName === 'canonicalState');

    expect(enumFilter).toBeDefined();
    expect(enumFilter.hasChoices).toBe(true);
    expect(enumFilter.choices).toContain('qualifying');
  });

  it('resolves boolean filter (isBoolean flag set)', () => {
    const locals = buildBackendLocals(baseEntity, withEntities());
    const isClosedFilter = locals.searchQuery.filters.find((f: any) => f.camelName === 'isClosed');

    expect(isClosedFilter).toBeDefined();
    expect(isClosedFilter.isBoolean).toBe(true);
  });

  it('exposes search use-case + controller output paths', () => {
    const locals = buildBackendLocals(baseEntity, withEntities());

    expect(locals.outputPaths.searchUseCase).toBe(
      'src/modules/opportunities/use-cases/search-opportunities.use-case.ts',
    );
    expect(locals.outputPaths.searchController).toBe(
      'src/modules/opportunities/opportunity-search.controller.ts',
    );
  });

  it('nulls search locals when no search query is declared', () => {
    const locals = buildBackendLocals(entityWithoutSearch, withEntities());

    expect(locals.hasSearchQuery).toBe(false);
    expect(locals.searchQuery).toBeNull();
    expect(locals.outputPaths.searchUseCase).toBeNull();
    expect(locals.outputPaths.searchController).toBeNull();
  });
});

describe('backend search templates — use-case rendering', () => {
  it('pages the filter-AND through the list use case, returning its Page<T> (#744)', () => {
    const locals = buildBackendLocals(baseEntity, withEntities());
    const output = render('use-cases/search.ejs.t', locals);

    expect(output).toContain('export class SearchOpportunitiesUseCase');
    expect(output).toContain('export interface SearchOpportunitiesInput extends ListQuery {');
    expect(output).toContain('Promise<Page<Opportunity>>');
    // The list endpoint's envelope, from the list's own specifier — never a
    // consumer-owned module (#744).
    expect(output).toContain(`import type { ListQuery, Page } from '${locals.paginationImport}';`);
    expect(output).not.toContain('@shared/http/pagination');
    expect(output).toContain('private readonly listUseCase: ListOpportunitiesUseCase');
    expect(output).toContain('return this.listUseCase.execute(input, { where: and(...conditions) });');
  });

  it('emits an ilike guard for the search field when declared', () => {
    const locals = buildBackendLocals(baseEntity, withEntities());
    const output = render('use-cases/search.ejs.t', locals);

    expect(output).toContain('ilike');
    expect(output).toContain('if (input.search) conditions.push(ilike(opportunities.name,');
  });

  it('emits boolean-aware filter guard (`!== undefined`) for boolean columns', () => {
    const locals = buildBackendLocals(baseEntity, withEntities());
    const output = render('use-cases/search.ejs.t', locals);

    expect(output).toContain('if (input.isClosed !== undefined) conditions.push(eq(opportunities.isClosed, input.isClosed));');
  });

  it('emits truthy-check filter guard for non-boolean columns', () => {
    const locals = buildBackendLocals(baseEntity, withEntities());
    const output = render('use-cases/search.ejs.t', locals);

    expect(output).toContain('if (input.userId) conditions.push(eq(opportunities.userId, input.userId));');
    expect(output).toContain('if (input.accountId) conditions.push(eq(opportunities.accountId, input.accountId));');
  });
});

describe('backend search templates — controller rendering', () => {
  it('emits the search controller with Zod querystring schema + /search route', () => {
    const locals = buildBackendLocals(baseEntity, withEntities());
    const output = render('search-controller.ejs.t', locals);

    expect(output).toContain('export class OpportunitySearchController');
    expect(output).toContain("@Controller('opportunities')");
    expect(output).toContain("@Get('search')");
    // The list's query schema, extended — same paging + sort params (#744).
    expect(output).toContain('const OpportunityFiltersSchema = ListQuerySchema.extend({');
    expect(output).toContain(
      `import { ListQuerySchema, type Page } from '${locals.paginationImport}';`,
    );
    expect(output).not.toContain('@shared/http/pagination');
    expect(output).toContain('@Query(new ZodValidationPipe(OpportunityFiltersSchema))');
    expect(output).toContain('): Promise<Page<Opportunity>> {');
  });

  it('emits correct zod types per filter kind', () => {
    const locals = buildBackendLocals(baseEntity, withEntities());
    const output = render('search-controller.ejs.t', locals);

    // UUID (belongs_to FK)
    expect(output).toContain('userId: z.string().uuid().optional()');
    expect(output).toContain('accountId: z.string().uuid().optional()');
    // Enum with choices
    expect(output).toContain("canonicalState: z.enum(['qualifying', 'developing', 'proposing', 'negotiating', 'closed_won', 'closed_lost']).optional()");
    // Boolean with coerce
    expect(output).toContain('isClosed: z.coerce.boolean().optional()');
    expect(output).toContain('isWon: z.coerce.boolean().optional()');
    // Plain string
    expect(output).toContain('provider: z.string().optional()');
    // Search field
    expect(output).toContain('search: z.string().optional()');
  });
});

describe('backend search templates — module rendering', () => {
  it('registers the search controller and use case when search is declared', () => {
    const locals = buildBackendLocals(baseEntity, withEntities());
    const output = render('module.ejs.t', locals);

    expect(output).toContain(
      "import { SearchOpportunitiesUseCase } from './use-cases/search-opportunities.use-case';",
    );
    expect(output).toContain(
      "import { OpportunitySearchController } from './opportunity-search.controller';",
    );
    expect(output).toContain('OpportunitySearchController');
    expect(output).toContain('SearchOpportunitiesUseCase,');
  });

  it('omits search wiring when no search query is declared', () => {
    const locals = buildBackendLocals(entityWithoutSearch, withEntities());
    const output = render('module.ejs.t', locals);

    expect(output).not.toContain('SearchOpportunitiesUseCase');
    expect(output).not.toContain('OpportunitySearchController');
    expect(output).not.toContain('search-opportunities.use-case');
  });
});

describe('backend search templates — schema union with by-column queries', () => {
  it('accepts mixed search + by-column queries in the same queries: block', () => {
    const mixed = {
      ...baseEntity,
      queries: [
        ...baseEntity.queries!,
        { by: ['email'], unique: true },
      ],
    };
    const locals = buildBackendLocals(mixed, withEntities());

    expect(locals.hasSearchQuery).toBe(true);
    // Legacy shape still processes; by-column queries appear in
    // processedQueries separately.
    expect(locals.processedQueries.length).toBe(1);
    expect(locals.processedQueries[0].methodName).toBe('findByEmail');
  });
});

describe('backend search templates — declaration schema', () => {
  // Search pages and sorts by the request's ListQuery, as the list does (#744):
  // a `paginate:` or `order:` key would be a switch nothing reads, so it is an
  // unknown-key error rather than silently dropped.
  for (const key of ['paginate', 'order'] as const) {
    it(`rejects \`${key}:\` on a search declaration`, () => {
      const value = key === 'paginate' ? true : 'name asc';
      const result = EntityDefinitionSchema.safeParse({
        ...baseEntity,
        queries: [{ ...baseEntity.queries[0], [key]: value }],
      });

      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain(`'${key}'`);
    });
  }

  it('accepts a search declaration without them', () => {
    expect(EntityDefinitionSchema.safeParse(baseEntity).success).toBe(true);
  });
});
