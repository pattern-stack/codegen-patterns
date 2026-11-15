---
to: "<%= outputPaths.controller %>"
skip_if: "<%= !apiSurface.http.enabled %>"
force: true
---
<%- generatedBanner %>
<%_
// ADR-046 — this template PRINTS the controller's routes. Which routes exist,
// their verb, path, handler, operationId and include wiring come from
// `apiSurface.http` (`src/derived/api/`); a route is looked up by the kind of
// the use case it runs. The Swagger text and the handler bodies stay here.
const _route = (kind) => {
  const uc = apiSurface.useCases.find((u) => u.kind === kind);
  return uc ? apiSurface.http.routes.find((r) => r.useCase === uc.className) : undefined;
};
const _list = _route('list');
const _findById = _route('find_by_id');
const _listWithFields = _route('list_with_fields');
const _findByIdWithFields = _route('find_by_id_with_fields');
const _create = _route('create');
const _update = _route('update');
const _delete = _route('delete');
// A base whose every kind has a child table has no create route (RFC-0006 §4.1) but keeps update / delete.
const _writes = !!(_update && _delete);
// The controller prefix is the list route's path; every other route's
// decorator argument is its path below that prefix. (With `api: false` there
// are no routes and the file is skipped; the body below is guarded on `_list`
// because hygen renders it before it reads `skip_if`.)
const _prefix = _list ? _list.path : '';
const _decorator = (r) => {
  const verb = { GET: 'Get', POST: 'Post', PATCH: 'Patch', DELETE: 'Delete' }[r.verb];
  const sub = r.path === _prefix ? '' : r.path.slice(_prefix.length + 1);
  return sub ? `@${verb}('${sub}')` : `@${verb}()`;
};
const _typedInclude = apiSurface.repository.typedInclude;
const _includeRoutes = apiSurface.http.includeRoutes;
const _allow = (r) => (r.includeRoute ? `${apiSurface.http.includesConst}.${r.includeRoute}` : 'undefined');
const _kindGuarded = isInheritanceChild || familyBase !== null;
_%>
<% if (_list) { -%>
import { BadRequestException, Controller<% if (_kindGuarded) { %>, ConflictException<% } %>, Get<% if (_create) { %>, Post<% } %><% if (_writes) { %>, Patch, Delete, Body<% } %>, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, <% if (_writes) { %>ApiBody, <% } %>ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ZodValidationPipe } from '<%= zodValidationPipeImport %>';
import type { Page } from '<%= paginationImport %>';
import { <%= classNames.listQuerySchema %> } from './dto/list-<%= entityPluralFileStem %>.query';
import type { <%= classNames.listQueryDto %> } from './dto/list-<%= entityPluralFileStem %>.query';
import { <%= classNames.findByIdUseCase %> } from './use-cases/find-<%= entityFileStem %>-by-id.use-case';
import { <%= classNames.listUseCase %> } from './use-cases/list-<%= entityPluralFileStem %>.use-case';
<% if (_findByIdWithFields || _listWithFields) { -%>
import { <%= classNames.findByIdWithFieldsUseCase %> } from './use-cases/find-<%= entityFileStem %>-by-id-with-fields.use-case';
import { <%= classNames.listWithFieldsUseCase %> } from './use-cases/list-<%= entityPluralFileStem %>-with-fields.use-case';
<% } -%>
<% if (_create) { -%>
import { <%= classNames.createUseCase %> } from './use-cases/create-<%= entityFileStem %>.use-case';
<% } -%>
<% if (_writes) { -%>
import { <%= classNames.updateUseCase %> } from './use-cases/update-<%= entityFileStem %>.use-case';
import { <%= classNames.deleteUseCase %> } from './use-cases/delete-<%= entityFileStem %>.use-case';
<% if (_create) { -%>
import { <%= classNames.createSchema %> } from './dto/create-<%= entityFileStem %>.dto';
import type { <%= classNames.createDto %> } from './dto/create-<%= entityFileStem %>.dto';
<% } -%>
import { <%= classNames.updateSchema %> } from './dto/update-<%= entityFileStem %>.dto';
import type { <%= classNames.updateDto %> } from './dto/update-<%= entityFileStem %>.dto';
<% } -%>
<% if (isInheritanceChild) { -%>
import type { <%= classNames.entity %>Flat } from './<%= entityFileStem %>.repository';
<% } else { -%>
import type { <%= classNames.entity %> } from './<%= entityFileStem %>.entity';
<% } -%>
<% if (_kindGuarded) { -%>
import {
  KindImmutableError,
  KindMismatchError,
  KindRequiresChildError,
} from '<%= inheritanceImport %>';
<% } -%>
// REL-2 (#587): the HTTP include allowlist (charter I6). A client sends dot
// PATHS; this controller looks each one up in a compile-time literal map and
// merges the fragments. It never builds an include tree from client input, and a
// path the allowlist does not name is a 400.
import {
  IncludeNotAllowedError,
  resolveAllowedInclude,
} from '<%= includesImport %>';
import type { <%= classNames.entity %>ApiResult } from './<%= entityFileStem %>.repository';
<%_ if (_typedInclude && _includeRoutes.length > 0) { _%>
import { <%= apiSurface.http.includesConst %> } from '<%= apiIncludesImport %>';
<%_ } _%>

// OPENAPI-3: decorators reference registered schemas by `$ref` because
// the DTOs are Zod-derived types (OPENAPI-2 registers them by name at
// onModuleInit). `ErrorResponseDto` is auto-registered by the shared
// registry.
@ApiBearerAuth()
@Controller('<%= _prefix.slice(1) %>')
export class <%= _list.controller %> {
  constructor(
    // All routes go through use cases (ADR-003 — no controller → service shortcuts)
    private readonly findByIdUseCase: <%= classNames.findByIdUseCase %>,
    private readonly listUseCase: <%= classNames.listUseCase %>,
<% if (_findByIdWithFields || _listWithFields) { -%>
    private readonly findByIdWithFieldsUseCase: <%= classNames.findByIdWithFieldsUseCase %>,
    private readonly listWithFieldsUseCase: <%= classNames.listWithFieldsUseCase %>,
<% } -%>
<% if (_writes) { -%>
<% if (_create) { -%>
    private readonly createUseCase: <%= classNames.createUseCase %>,
<% } -%>
    private readonly updateUseCase: <%= classNames.updateUseCase %>,
    private readonly deleteUseCase: <%= classNames.deleteUseCase %>,
<% } -%>
  ) {}

  /**
   * Resolve `?include=` against ONE route's allowlist, or reject.
   *
   * `allow === undefined` means the route declares no `api.includes` entry, and
   * that is not "allow everything" — it is "allow nothing". Every entity that
   * exists today is in exactly that state, which is what makes REL-2 change no
   * HTTP behaviour until a consumer opts in (charter I6).
   */
  private resolveInclude<TFragment>(
    raw: string | undefined,
    allow: globalThis.Readonly<globalThis.Record<string, TFragment>> | undefined,
  ): TFragment | undefined {
    try {
      return resolveAllowedInclude(raw, allow);
    } catch (err: unknown) {
      if (err instanceof IncludeNotAllowedError) {
        throw new BadRequestException({ statusCode: 400, error: 'Bad Request', code: err.code, path: err.path, message: err.message });
      }
      throw err;
    }
  }

  @ApiOperation({ summary: 'List <%= entityNamePlural %>', operationId: '<%= _list.operationId %>' })
  @ApiQuery({ name: 'page', required: false, type: 'integer', description: '1-based page number (default 1).' })
  @ApiQuery({ name: 'pageSize', required: false, type: 'integer', description: 'Page size (default 50, max 200).' })
  @ApiQuery({ name: 'cursor', required: false, type: 'string', description: 'Opaque keyset cursor (accepted; v1 paginates by offset).' })
  @ApiQuery({ name: 'sort_by', required: false, type: 'string', description: "Sort column (default 'created_at')." })
  @ApiQuery({ name: 'sort_order', required: false, enum: ['asc', 'desc'], description: "Sort direction (default 'desc')." })
  @ApiQuery({
    name: 'include',
    required: false,
    type: 'string',
    description:
<%_ if (_includeRoutes.includes('list')) { _%>
      'Comma-separated include paths, written as relation keys (camelCase), allowlisted by api.includes.list in the entity YAML. Anything else is a 400.',
<%_ } else { _%>
      'No include is exposed on this route (no api.includes.list in the entity YAML), so any value is a 400.',
<%_ } _%>
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { $ref: '#/components/schemas/<%= classNames.outputDto %>' } },
        page: { type: 'integer' },
        pageCount: { type: 'integer' },
        total: { type: 'integer' },
        pageSize: { type: 'integer' },
        nextCursor: { type: 'string', nullable: true },
      },
      required: ['items', 'page', 'pageCount', 'total', 'pageSize', 'nextCursor'],
    },
  })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  <%- _decorator(_list) %>
  async <%= _list.handler %>(
    @Query(new ZodValidationPipe(<%= classNames.listQuerySchema %>)) query: <%= classNames.listQueryDto %>,
    @Query('include') include?: string,
  ): Promise<Page<<%= classNames.entity %>ApiResult>> {
<% if (_typedInclude) { -%>
    return this.listUseCase.execute(query, {
      include: this.resolveInclude(include, <%- _allow(_list) %>),
    });
<% } else { -%>
    // <%= entityName %> has no relations in the generated graph, so there is no
    // include to expose — but the parameter is still VALIDATED, so `?include=`
    // is a 400 here exactly as it is on an un-allowlisted route (charter I6).
    this.resolveInclude(include, undefined);
    return this.listUseCase.execute(query);
<% } -%>
  }
<% if (_listWithFields) { %>
  @ApiOperation({
    summary: 'List <%= entityNamePlural %> with EAV fields',
    operationId: '<%= _listWithFields.operationId %>',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  <%- _decorator(_listWithFields) %>
  async <%= _listWithFields.handler %>(): Promise<Array<<%= classNames.entity %> & { fields: globalThis.Record<string, unknown> }>> {
    return this.listWithFieldsUseCase.execute();
  }
<% } %>
  @ApiOperation({ summary: 'Find <%= entityName %> by id', operationId: '<%= _findById.operationId %>' })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/<%= classNames.outputDto %>' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiQuery({
    name: 'include',
    required: false,
    type: 'string',
    description:
<%_ if (_includeRoutes.includes('find_by_id')) { _%>
      'Comma-separated include paths, written as relation keys (camelCase), allowlisted by api.includes.find_by_id in the entity YAML. Anything else is a 400.',
<%_ } else { _%>
      'No include is exposed on this route (no `api.includes.find_by_id` in the entity YAML), so any value is a 400.',
<%_ } _%>
  })
  <%- _decorator(_findById) %>
  async <%= _findById.handler %>(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('include') include?: string,
  ): Promise<<%= classNames.entity %>ApiResult> {
    // Use case throws NotFoundException on null/undefined (D2)
<% if (_typedInclude) { -%>
    return this.findByIdUseCase.execute(
      id,
      this.resolveInclude(include, <%- _allow(_findById) %>),
    );
<% } else { -%>
    this.resolveInclude(include, undefined);
    return this.findByIdUseCase.execute(id);
<% } -%>
  }
<% if (_findByIdWithFields) { %>
  @ApiOperation({
    summary: 'Find <%= entityName %> with EAV fields',
    operationId: '<%= _findByIdWithFields.operationId %>',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  <%- _decorator(_findByIdWithFields) %>
  async <%= _findByIdWithFields.handler %>(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<<%= classNames.entity %> & { fields: globalThis.Record<string, unknown> }> {
    const entity = await this.findByIdWithFieldsUseCase.execute(id);
    if (!entity) throw new NotFoundException(`<%= classNames.entity %> ${id} not found`);
    return entity;
  }
<% } %>
<%_ const _W = isInheritanceChild ? `${classNames.entity}Flat` : classNames.entity; _%>
<% if (_writes) { %>
<%_ if (_kindGuarded) { _%>
  /**
   * RFC-0006 §4.1: the family's domain errors are HTTP answers, mapped HERE — the one place this layer already turns a
   * domain error into a status (`resolveInclude`'s 400). Bodies match `ErrorResponseDto` (`statusCode`, `error`,
   * `message`) plus a stable `code`. `KindImmutableError` and `KindRequiresChildError` are a request no state of the
   * server could make valid (400; the second names the route to use); `KindMismatchError` depends on a row that already
   * exists (409).
   */
  private kindError(err: unknown): unknown {
    if (err instanceof KindImmutableError) {
      return new BadRequestException({ statusCode: 400, error: 'Bad Request', code: 'kind_immutable', message: err.message });
    }
    if (err instanceof KindRequiresChildError) {
      return new BadRequestException({ statusCode: 400, error: 'Bad Request', code: 'kind_requires_child', kind: err.kind, createPath: err.createPath, message: err.message });
    }
    if (err instanceof KindMismatchError) {
      return new ConflictException({ statusCode: 409, error: 'Conflict', code: 'kind_mismatch', message: err.message });
    }
    return err;
  }

<%_ } _%>
<%_ if (_create) { _%>
  @ApiOperation({ summary: 'Create <%= entityName %>', operationId: '<%= _create.operationId %>' })
  @ApiBody({ schema: { $ref: '#/components/schemas/<%= classNames.createDto %>' } })
  @ApiResponse({ status: 201, schema: { $ref: '#/components/schemas/<%= classNames.outputDto %>' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  <%- _decorator(_create) %>
  async <%= _create.handler %>(
    @Body(new ZodValidationPipe(<%= classNames.createSchema %>)) dto: <%= classNames.createDto %>,
  ): Promise<<%= _W %>> {
<% if (_kindGuarded) { -%>
    try {
      return await this.createUseCase.execute(dto);
    } catch (err: unknown) {
      throw this.kindError(err);
    }
<% } else { -%>
    return this.createUseCase.execute(dto);
<% } -%>
  }
<% } %>
  @ApiOperation({ summary: 'Update <%= entityName %>', operationId: '<%= _update.operationId %>' })
  @ApiBody({ schema: { $ref: '#/components/schemas/<%= classNames.updateDto %>' } })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/<%= classNames.outputDto %>' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  <%- _decorator(_update) %>
  async <%= _update.handler %>(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(<%= classNames.updateSchema %>)) dto: <%= classNames.updateDto %>,
  ): Promise<<%= _W %>> {
<% if (_kindGuarded) { -%>
    let entity: <%= _W %> | null;
    try {
      entity = await this.updateUseCase.execute(id, dto);
    } catch (err: unknown) {
      throw this.kindError(err);
    }
<% } else { -%>
    const entity = await this.updateUseCase.execute(id, dto);
<% } -%>
    if (!entity) throw new NotFoundException(`<%= classNames.entity %> ${id} not found`);
    return entity;
  }

  @ApiOperation({ summary: 'Delete <%= entityName %>', operationId: '<%= _delete.operationId %>' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  <%- _decorator(_delete) %>
  async <%= _delete.handler %>(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.deleteUseCase.execute(id);
  }
<% } %>
}
<% } -%>
