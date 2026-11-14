
import { BadRequestException, Controller, Get, Post, Patch, Delete, Body, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ZodValidationPipe } from '@shared/pipes/zod-validation.pipe';
import type { Page } from '@shared/http/page';
import { ListLeadsQuerySchema } from './dto/list-leads.query';
import type { ListLeadsQueryDto } from './dto/list-leads.query';
import { FindLeadByIdUseCase } from './use-cases/find-lead-by-id.use-case';
import { ListLeadsUseCase } from './use-cases/list-leads.use-case';
import { FindLeadByIdWithFieldsUseCase } from './use-cases/find-lead-by-id-with-fields.use-case';
import { ListLeadsWithFieldsUseCase } from './use-cases/list-leads-with-fields.use-case';
import { CreateLeadUseCase } from './use-cases/create-lead.use-case';
import { UpdateLeadUseCase } from './use-cases/update-lead.use-case';
import { DeleteLeadUseCase } from './use-cases/delete-lead.use-case';
import { CreateLeadSchema } from './dto/create-lead.dto';
import type { CreateLeadDto } from './dto/create-lead.dto';
import { UpdateLeadSchema } from './dto/update-lead.dto';
import type { UpdateLeadDto } from './dto/update-lead.dto';
import type { Lead } from './lead.entity';
// REL-2 (#587): the HTTP include allowlist (charter I6). A client sends dot
// PATHS; this controller looks each one up in a compile-time literal map and
// merges the fragments. It never builds an include tree from client input, and a
// path the allowlist does not name is a 400.
import {
  IncludeNotAllowedError,
  resolveAllowedInclude,
} from '@shared/http/includes';
import type { LeadApiResult } from './lead.repository';

// OPENAPI-3: decorators reference registered schemas by `$ref` because
// the DTOs are Zod-derived types (OPENAPI-2 registers them by name at
// onModuleInit). `ErrorResponseDto` is auto-registered by the shared
// registry.
@ApiBearerAuth()
@Controller('leads')
export class LeadController {
  constructor(
    // All routes go through use cases (ADR-003 — no controller → service shortcuts)
    private readonly findByIdUseCase: FindLeadByIdUseCase,
    private readonly listUseCase: ListLeadsUseCase,
    private readonly findByIdWithFieldsUseCase: FindLeadByIdWithFieldsUseCase,
    private readonly listWithFieldsUseCase: ListLeadsWithFieldsUseCase,
    private readonly createUseCase: CreateLeadUseCase,
    private readonly updateUseCase: UpdateLeadUseCase,
    private readonly deleteUseCase: DeleteLeadUseCase,
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
        throw new BadRequestException({ code: err.code, path: err.path, message: err.message });
      }
      throw err;
    }
  }

  @ApiOperation({ summary: 'List leads', operationId: 'listLeads' })
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
      'No include is exposed on this route (no api.includes.list in the entity YAML), so any value is a 400.',
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { $ref: '#/components/schemas/LeadOutputDto' } },
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
    @Query(new ZodValidationPipe(ListLeadsQuerySchema)) query: ListLeadsQueryDto,
    @Query('include') include?: string,
  ): Promise<Page<LeadApiResult>> {
    // lead has no relations in the generated graph, so there is no
    // include to expose — but the parameter is still VALIDATED, so `?include=`
    // is a 400 here exactly as it is on an un-allowlisted route (charter I6).
    this.resolveInclude(include, undefined);
    return this.listUseCase.execute(query);
  }

  @ApiOperation({
    summary: 'List leads with EAV fields',
    operationId: 'listLeadsWithFields',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @Get('with-fields')
  async getAllWithFields(): Promise<Array<Lead & { fields: globalThis.Record<string, unknown> }>> {
    return this.listWithFieldsUseCase.execute();
  }

  @ApiOperation({ summary: 'Find lead by id', operationId: 'findLeadById' })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/LeadOutputDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiQuery({
    name: 'include',
    required: false,
    type: 'string',
    description:
      'No include is exposed on this route (no `api.includes.find_by_id` in the entity YAML), so any value is a 400.',
  })
  @Get(':id')
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('include') include?: string,
  ): Promise<LeadApiResult> {
    // Use case throws NotFoundException on null/undefined (D2)
    this.resolveInclude(include, undefined);
    return this.findByIdUseCase.execute(id);
  }

  @ApiOperation({
    summary: 'Find lead with EAV fields',
    operationId: 'findLeadByIdWithFields',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @Get(':id/with-fields')
  async getByIdWithFields(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Lead & { fields: globalThis.Record<string, unknown> }> {
    const entity = await this.findByIdWithFieldsUseCase.execute(id);
    if (!entity) throw new NotFoundException(`Lead ${id} not found`);
    return entity;
  }


  @ApiOperation({ summary: 'Create lead', operationId: 'createLead' })
  @ApiBody({ schema: { $ref: '#/components/schemas/CreateLeadDto' } })
  @ApiResponse({ status: 201, schema: { $ref: '#/components/schemas/LeadOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @Post()
  async create(
    @Body(new ZodValidationPipe(CreateLeadSchema)) dto: CreateLeadDto,
  ): Promise<Lead> {
    return this.createUseCase.execute(dto);
  }

  @ApiOperation({ summary: 'Update lead', operationId: 'updateLead' })
  @ApiBody({ schema: { $ref: '#/components/schemas/UpdateLeadDto' } })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/LeadOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateLeadSchema)) dto: UpdateLeadDto,
  ): Promise<Lead> {
    const entity = await this.updateUseCase.execute(id, dto);
    if (!entity) throw new NotFoundException(`Lead ${id} not found`);
    return entity;
  }

  @ApiOperation({ summary: 'Delete lead', operationId: 'deleteLead' })
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

}
