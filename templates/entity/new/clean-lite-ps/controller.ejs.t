---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.controller : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' || clpApiEnabled === false %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
import { Controller, Get<% if (generateWrites) { %>, Post, Patch, Delete, Body<% } %>, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, <% if (generateWrites) { %>ApiBody, <% } %>ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ZodValidationPipe } from '<%= typeof zodValidationPipeImport !== 'undefined' ? zodValidationPipeImport : '@shared/pipes/zod-validation.pipe' %>';
import type { Page } from '<%= typeof paginationImport !== 'undefined' ? paginationImport : '@shared/http/pagination' %>';
import { <%= classNames.listQuerySchema %> } from './dto/list-<%= entityNamePlural %>.query';
import type { <%= classNames.listQueryDto %> } from './dto/list-<%= entityNamePlural %>.query';
import { <%= classNames.findByIdUseCase %> } from './use-cases/find-<%= entityName %>-by-id.use-case';
import { <%= classNames.listUseCase %> } from './use-cases/list-<%= entityNamePlural %>.use-case';
<% if (eavEnabled) { -%>
import { <%= classNames.findByIdWithFieldsUseCase %> } from './use-cases/find-<%= entityName %>-by-id-with-fields.use-case';
import { <%= classNames.listWithFieldsUseCase %> } from './use-cases/list-<%= entityNamePlural %>-with-fields.use-case';
<% } -%>
<% if (generateWrites) { -%>
import { <%= classNames.createUseCase %> } from './use-cases/create-<%= entityName %>.use-case';
import { <%= classNames.updateUseCase %> } from './use-cases/update-<%= entityName %>.use-case';
import { <%= classNames.deleteUseCase %> } from './use-cases/delete-<%= entityName %>.use-case';
import { <%= classNames.createSchema %> } from './dto/create-<%= entityName %>.dto';
import type { <%= classNames.createDto %> } from './dto/create-<%= entityName %>.dto';
import { <%= classNames.updateSchema %> } from './dto/update-<%= entityName %>.dto';
import type { <%= classNames.updateDto %> } from './dto/update-<%= entityName %>.dto';
<% } -%>
import type { <%= classNames.entity %> } from './<%= entityName %>.entity';

// OPENAPI-3: decorators reference registered schemas by `$ref` because
// CLP DTOs are Zod-derived types (OPENAPI-2 registers them by name at
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

  @ApiOperation({ summary: 'List <%= entityNamePlural %>', operationId: 'list<%= classNames.entity %>s' })
  @ApiQuery({ name: 'page', required: false, type: 'integer', description: '1-based page number (default 1).' })
  @ApiQuery({ name: 'pageSize', required: false, type: 'integer', description: 'Page size (default 50, max 200).' })
  @ApiQuery({ name: 'cursor', required: false, type: 'string', description: 'Opaque keyset cursor (accepted; v1 paginates by offset).' })
  @ApiQuery({ name: 'sort_by', required: false, type: 'string', description: "Sort column (default 'created_at')." })
  @ApiQuery({ name: 'sort_order', required: false, enum: ['asc', 'desc'], description: "Sort direction (default 'desc')." })
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
  ): Promise<Page<<%= classNames.entity %>>> {
    return this.listUseCase.execute(query);
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
  @Get(':id')
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<<%= classNames.entity %>> {
    // Use case throws NotFoundException on null/undefined (D2)
    return this.findByIdUseCase.execute(id);
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
