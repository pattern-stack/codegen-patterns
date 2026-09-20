---
to: "<%= outputPaths.controller %>"
skip_if: "<%= apiEnabled === false %>"
force: true
---
<%- generatedBanner %>
import { BadRequestException, Controller, Get<% if (generateWrites) { %>, Post, Patch, Delete, Body<% } %>, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, <% if (generateWrites) { %>ApiBody, <% } %>ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ZodValidationPipe } from '<%= zodValidationPipeImport %>';
import type { Page } from '<%= paginationImport %>';
import { <%= classNames.listQuerySchema %> } from './dto/list-<%= entityPluralFileStem %>.query';
import type { <%= classNames.listQueryDto %> } from './dto/list-<%= entityPluralFileStem %>.query';
import { <%= classNames.findByIdUseCase %> } from './use-cases/find-<%= entityFileStem %>-by-id.use-case';
import { <%= classNames.listUseCase %> } from './use-cases/list-<%= entityPluralFileStem %>.use-case';
<% if (eavEnabled) { -%>
import { <%= classNames.findByIdWithFieldsUseCase %> } from './use-cases/find-<%= entityFileStem %>-by-id-with-fields.use-case';
import { <%= classNames.listWithFieldsUseCase %> } from './use-cases/list-<%= entityPluralFileStem %>-with-fields.use-case';
<% } -%>
<% if (generateWrites) { -%>
import { <%= classNames.createUseCase %> } from './use-cases/create-<%= entityFileStem %>.use-case';
import { <%= classNames.updateUseCase %> } from './use-cases/update-<%= entityFileStem %>.use-case';
import { <%= classNames.deleteUseCase %> } from './use-cases/delete-<%= entityFileStem %>.use-case';
import { <%= classNames.createSchema %> } from './dto/create-<%= entityFileStem %>.dto';
import type { <%= classNames.createDto %> } from './dto/create-<%= entityFileStem %>.dto';
import { <%= classNames.updateSchema %> } from './dto/update-<%= entityFileStem %>.dto';
import type { <%= classNames.updateDto %> } from './dto/update-<%= entityFileStem %>.dto';
<% } -%>
import type { <%= classNames.entity %> } from './<%= entityFileStem %>.entity';
// REL-2 (#587): the HTTP include allowlist (charter I6). A client sends dot
// PATHS; this controller looks each one up in a compile-time literal map and
// merges the fragments. It never builds an include tree from client input, and a
// path the allowlist does not name is a 400.
import {
  IncludeNotAllowedError,
  resolveAllowedInclude,
} from '<%= includesImport %>';
import type { <%= classNames.entity %>ApiResult } from './<%= entityFileStem %>.repository';
<%_ if (includes && apiIncludeRoutes.length > 0) { _%>
import { <%= apiIncludesConst %> } from '<%= apiIncludesImport %>';
<%_ } _%>

// OPENAPI-3: decorators reference registered schemas by `$ref` because
// the DTOs are Zod-derived types (OPENAPI-2 registers them by name at
// onModuleInit). `ErrorResponseDto` is auto-registered by the shared
// registry.
@ApiBearerAuth()
@Controller('<%= entityNamePlural %>')
export class <%= classNames.controller %> {
  constructor(
    // All routes go through use cases (ADR-003 — no controller → service shortcuts)
    private readonly findByIdUseCase: <%= classNames.findByIdUseCase %>,
    private readonly listUseCase: <%= classNames.listUseCase %>,
<% if (eavEnabled) { -%>
    private readonly findByIdWithFieldsUseCase: <%= classNames.findByIdWithFieldsUseCase %>,
    private readonly listWithFieldsUseCase: <%= classNames.listWithFieldsUseCase %>,
<% } -%>
<% if (generateWrites) { -%>
    private readonly createUseCase: <%= classNames.createUseCase %>,
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
    allow: Readonly<Record<string, TFragment>> | undefined,
  ): TFragment | undefined {
    try {
      return resolveAllowedInclude(raw, allow);
    } catch (err: unknown) {
      if (err instanceof IncludeNotAllowedError) {
        throw new BadRequestException({ code: err.code, path: err.path, message: err.message });
      }
      throw err;
    }
  }

  @ApiOperation({ summary: 'List <%= entityNamePlural %>', operationId: 'list<%= classNames.entity %>s' })
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
<%_ if (apiIncludeRoutes.includes('list')) { _%>
      'Comma-separated allowlisted include paths (see api.includes.list in the entity YAML). Anything else is a 400.',
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
  @Get()
  async getAll(
    @Query(new ZodValidationPipe(<%= classNames.listQuerySchema %>)) query: <%= classNames.listQueryDto %>,
    @Query('include') include?: string,
  ): Promise<Page<<%= classNames.entity %>ApiResult>> {
<% if (includes) { -%>
    return this.listUseCase.execute(
      query,
      this.resolveInclude(include, <%- apiIncludeRoutes.includes('list') ? `${apiIncludesConst}.list` : 'undefined' %>),
    );
<% } else { -%>
    // <%= entityName %> has no relations in the generated graph, so there is no
    // include to expose — but the parameter is still VALIDATED, so `?include=`
    // is a 400 here exactly as it is on an un-allowlisted route (charter I6).
    this.resolveInclude(include, undefined);
    return this.listUseCase.execute(query);
<% } -%>
  }
<% if (eavEnabled) { %>
  @ApiOperation({
    summary: 'List <%= entityNamePlural %> with EAV fields',
    operationId: 'list<%= classNames.entity %>sWithFields',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @Get('with-fields')
  async getAllWithFields(): Promise<Array<<%= classNames.entity %> & { fields: Record<string, unknown> }>> {
    return this.listWithFieldsUseCase.execute();
  }
<% } %>
  @ApiOperation({ summary: 'Find <%= entityName %> by id', operationId: 'find<%= classNames.entity %>ById' })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/<%= classNames.outputDto %>' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiQuery({
    name: 'include',
    required: false,
    type: 'string',
    description:
<%_ if (apiIncludeRoutes.includes('find_by_id')) { _%>
      'Comma-separated allowlisted include paths (see api.includes.find_by_id in the entity YAML). Anything else is a 400.',
<%_ } else { _%>
      'No include is exposed on this route (no `api.includes.find_by_id` in the entity YAML), so any value is a 400.',
<%_ } _%>
  })
  @Get(':id')
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('include') include?: string,
  ): Promise<<%= classNames.entity %>ApiResult> {
    // Use case throws NotFoundException on null/undefined (D2)
<% if (includes) { -%>
    return this.findByIdUseCase.execute(
      id,
      this.resolveInclude(include, <%- apiIncludeRoutes.includes('find_by_id') ? `${apiIncludesConst}.find_by_id` : 'undefined' %>),
    );
<% } else { -%>
    this.resolveInclude(include, undefined);
    return this.findByIdUseCase.execute(id);
<% } -%>
  }
<% if (eavEnabled) { %>
  @ApiOperation({
    summary: 'Find <%= entityName %> with EAV fields',
    operationId: 'find<%= classNames.entity %>ByIdWithFields',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @Get(':id/with-fields')
  async getByIdWithFields(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<<%= classNames.entity %> & { fields: Record<string, unknown> }> {
    const entity = await this.findByIdWithFieldsUseCase.execute(id);
    if (!entity) throw new NotFoundException(`<%= classNames.entity %> ${id} not found`);
    return entity;
  }
<% } %>
<% if (generateWrites) { %>
  @ApiOperation({ summary: 'Create <%= entityName %>', operationId: 'create<%= classNames.entity %>' })
  @ApiBody({ schema: { $ref: '#/components/schemas/<%= classNames.createDto %>' } })
  @ApiResponse({ status: 201, schema: { $ref: '#/components/schemas/<%= classNames.outputDto %>' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @Post()
  async create(
    @Body(new ZodValidationPipe(<%= classNames.createSchema %>)) dto: <%= classNames.createDto %>,
  ): Promise<<%= classNames.entity %>> {
    return this.createUseCase.execute(dto);
  }

  @ApiOperation({ summary: 'Update <%= entityName %>', operationId: 'update<%= classNames.entity %>' })
  @ApiBody({ schema: { $ref: '#/components/schemas/<%= classNames.updateDto %>' } })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/<%= classNames.outputDto %>' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(<%= classNames.updateSchema %>)) dto: <%= classNames.updateDto %>,
  ): Promise<<%= classNames.entity %>> {
    const entity = await this.updateUseCase.execute(id, dto);
    if (!entity) throw new NotFoundException(`<%= classNames.entity %> ${id} not found`);
    return entity;
  }

  @ApiOperation({ summary: 'Delete <%= entityName %>', operationId: 'delete<%= classNames.entity %>' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @Delete(':id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.deleteUseCase.execute(id);
  }
<% } %>
}
