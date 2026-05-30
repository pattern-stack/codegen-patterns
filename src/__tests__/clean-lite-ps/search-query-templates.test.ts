/**
 * Template rendering tests for clean-lite-ps YAML filter/search query
 * generation (task #16).
 *
 * A `queries: - name: search` block in entity YAML should emit:
 *   - SearchXsUseCase with filter-AND + optional ilike + count for total
 *   - <entity>-search.controller.ts with Zod-validated querystring
 *   - Module wires both into controllers[] and providers[]
 *
 * Entities without a search query keep the existing shape; non-search
 * queries (the by-column form) pass through the union unchanged.
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
      paginate: true,
    },
  ],
};

const entityWithoutSearch = { ...baseEntity, queries: undefined };

describe('clean-lite-ps search templates — prompt-extension wiring', () => {
  it('builds searchQuery locals when queries declares a search', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});

    expect(locals.hasSearchQuery).toBe(true);
    expect(locals.searchQuery).not.toBeNull();
    expect(locals.searchQuery.useCaseClassName).toBe('SearchOpportunitiesUseCase');
    expect(locals.searchQuery.filtersSchemaName).toBe('OpportunityFiltersSchema');
    expect(locals.searchQuery.inputTypeName).toBe('SearchOpportunitiesInput');
    expect(locals.searchQuery.searchField).toBe('name');
    expect(locals.searchQuery.paginate).toBe(true);
  });

  it('resolves belongs_to FKs in filters (account_id → isUuid)', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const accountIdFilter = locals.searchQuery.filters.find((f: any) => f.camelName === 'accountId');

    expect(accountIdFilter).toBeDefined();
    expect(accountIdFilter.isUuid).toBe(true);
  });

  it('resolves enum filter with choices', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const enumFilter = locals.searchQuery.filters.find((f: any) => f.camelName === 'canonicalState');

    expect(enumFilter).toBeDefined();
    expect(enumFilter.hasChoices).toBe(true);
    expect(enumFilter.choices).toContain('qualifying');
  });

  it('resolves boolean filter (isBoolean flag set)', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const isClosedFilter = locals.searchQuery.filters.find((f: any) => f.camelName === 'isClosed');

    expect(isClosedFilter).toBeDefined();
    expect(isClosedFilter.isBoolean).toBe(true);
  });

  it('exposes search use-case + controller output paths', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});

    expect(locals.clpOutputPaths.searchUseCase).toBe(
      'src/modules/opportunities/use-cases/search-opportunities.use-case.ts',
    );
    expect(locals.clpOutputPaths.searchController).toBe(
      'src/modules/opportunities/opportunity-search.controller.ts',
    );
  });

  it('nulls search locals when no search query is declared', () => {
    const locals = buildCleanLitePsLocals(entityWithoutSearch, {});

    expect(locals.hasSearchQuery).toBe(false);
    expect(locals.searchQuery).toBeNull();
    expect(locals.clpOutputPaths.searchUseCase).toBeNull();
    expect(locals.clpOutputPaths.searchController).toBeNull();
  });
});

describe('clean-lite-ps search templates — use-case rendering', () => {
  it('emits SearchOpportunitiesUseCase with filter-AND + count for total', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('use-cases/search.ejs.t', locals);

    expect(output).toContain('export class SearchOpportunitiesUseCase');
    expect(output).toContain('export interface SearchOpportunitiesInput');
    expect(output).toContain('Promise<Page<Opportunity>>');
    expect(output).toContain("import type { Page } from '@shared/http/pagination';");
    expect(output).toContain('this.service.list({ where, limit: input.limit, offset: input.offset');
    expect(output).toContain('this.service.count(where)');
  });

  it('emits an ilike guard for the search field when declared', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('use-cases/search.ejs.t', locals);

    expect(output).toContain('ilike');
    expect(output).toContain('if (input.search) conditions.push(ilike(opportunities.name,');
  });

  it('emits boolean-aware filter guard (`!== undefined`) for boolean columns', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('use-cases/search.ejs.t', locals);

    expect(output).toContain('if (input.isClosed !== undefined) conditions.push(eq(opportunities.isClosed, input.isClosed));');
  });

  it('emits truthy-check filter guard for non-boolean columns', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('use-cases/search.ejs.t', locals);

    expect(output).toContain('if (input.userId) conditions.push(eq(opportunities.userId, input.userId));');
    expect(output).toContain('if (input.accountId) conditions.push(eq(opportunities.accountId, input.accountId));');
  });
});

describe('clean-lite-ps search templates — controller rendering', () => {
  it('emits the search controller with Zod querystring schema + /search route', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
    const output = render('search-controller.ejs.t', locals);

    expect(output).toContain('export class OpportunitySearchController');
    expect(output).toContain("@Controller('opportunities')");
    expect(output).toContain("@Get('search')");
    expect(output).toContain('const OpportunityFiltersSchema = z.object({');
    expect(output).toContain('}).merge(PaginationSchema);');
    expect(output).toContain(
      "import { PaginationSchema } from '@shared/http/pagination';",
    );
  });

  it('emits correct zod types per filter kind', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
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

describe('clean-lite-ps search templates — module rendering', () => {
  it('registers the search controller and use case when search is declared', () => {
    const locals = buildCleanLitePsLocals(baseEntity, {});
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
    const locals = buildCleanLitePsLocals(entityWithoutSearch, {});
    const output = render('module.ejs.t', locals);

    expect(output).not.toContain('SearchOpportunitiesUseCase');
    expect(output).not.toContain('OpportunitySearchController');
    expect(output).not.toContain('search-opportunities.use-case');
  });
});

describe('clean-lite-ps search templates — schema union with legacy by-column queries', () => {
  it('accepts mixed search + by-column queries in the same queries: block', () => {
    const mixed = {
      ...baseEntity,
      queries: [
        ...baseEntity.queries!,
        { by: ['email'], unique: true },
      ],
    };
    const locals = buildCleanLitePsLocals(mixed, {});

    expect(locals.hasSearchQuery).toBe(true);
    // Legacy shape still processes; by-column queries appear in
    // processedQueries separately.
    expect(locals.processedQueries.length).toBe(1);
    expect(locals.processedQueries[0].methodName).toBe('findByEmail');
  });
});
