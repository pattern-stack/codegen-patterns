
import { BadRequestException, Controller, Get, Post, Patch, Delete, Body, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ZodValidationPipe } from '@shared/pipes/zod-validation.pipe';
import type { Page } from '@shared/http/page';
import { ListSeaFreightsQuerySchema } from './dto/list-sea-freights.query';
import type { ListSeaFreightsQueryDto } from './dto/list-sea-freights.query';
import { FindSeaFreightByIdUseCase } from './use-cases/find-sea-freight-by-id.use-case';
import { ListSeaFreightsUseCase } from './use-cases/list-sea-freights.use-case';
import { CreateSeaFreightUseCase } from './use-cases/create-sea-freight.use-case';
import { UpdateSeaFreightUseCase } from './use-cases/update-sea-freight.use-case';
import { DeleteSeaFreightUseCase } from './use-cases/delete-sea-freight.use-case';
import { CreateSeaFreightSchema } from './dto/create-sea-freight.dto';
import type { CreateSeaFreightDto } from './dto/create-sea-freight.dto';
import { UpdateSeaFreightSchema } from './dto/update-sea-freight.dto';
import type { UpdateSeaFreightDto } from './dto/update-sea-freight.dto';
import type { SeaFreightFlat } from './sea-freight.repository';
// REL-2 (#587): the HTTP include allowlist (charter I6). A client sends dot
// PATHS; this controller looks each one up in a compile-time literal map and
// merges the fragments. It never builds an include tree from client input, and a
// path the allowlist does not name is a 400.
import {
  IncludeNotAllowedError,
  resolveAllowedInclude,
} from '@shared/http/includes';
import type { SeaFreightApiResult } from './sea-freight.repository';

// OPENAPI-3: decorators reference registered schemas by `$ref` because
// the DTOs are Zod-derived types (OPENAPI-2 registers them by name at
// onModuleInit). `ErrorResponseDto` is auto-registered by the shared
// registry.
@ApiBearerAuth()
@Controller('sea_freights')
export class SeaFreightController {
  constructor(
    // All routes go through use cases (ADR-003 — no controller → service shortcuts)
    private readonly findByIdUseCase: FindSeaFreightByIdUseCase,
    private readonly listUseCase: ListSeaFreightsUseCase,
    private readonly createUseCase: CreateSeaFreightUseCase,
    private readonly updateUseCase: UpdateSeaFreightUseCase,
    private readonly deleteUseCase: DeleteSeaFreightUseCase,
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

  @ApiOperation({ summary: 'List sea_freights', operationId: 'listSeaFreights' })
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
        items: { type: 'array', items: { $ref: '#/components/schemas/SeaFreightOutputDto' } },
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
    @Query(new ZodValidationPipe(ListSeaFreightsQuerySchema)) query: ListSeaFreightsQueryDto,
    @Query('include') include?: string,
  ): Promise<Page<SeaFreightApiResult>> {
    return this.listUseCase.execute(query, {
      include: this.resolveInclude(include, undefined),
    });
  }

  @ApiOperation({ summary: 'Find sea_freight by id', operationId: 'findSeaFreightById' })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/SeaFreightOutputDto' } })
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
  ): Promise<SeaFreightApiResult> {
    // Use case throws NotFoundException on null/undefined (D2)
    return this.findByIdUseCase.execute(
      id,
      this.resolveInclude(include, undefined),
    );
  }


  @ApiOperation({ summary: 'Create sea_freight', operationId: 'createSeaFreight' })
  @ApiBody({ schema: { $ref: '#/components/schemas/CreateSeaFreightDto' } })
  @ApiResponse({ status: 201, schema: { $ref: '#/components/schemas/SeaFreightOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @Post()
  async create(
    @Body(new ZodValidationPipe(CreateSeaFreightSchema)) dto: CreateSeaFreightDto,
  ): Promise<SeaFreightFlat> {
    return this.createUseCase.execute(dto);
  }

  @ApiOperation({ summary: 'Update sea_freight', operationId: 'updateSeaFreight' })
  @ApiBody({ schema: { $ref: '#/components/schemas/UpdateSeaFreightDto' } })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/SeaFreightOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateSeaFreightSchema)) dto: UpdateSeaFreightDto,
  ): Promise<SeaFreightFlat> {
    const entity = await this.updateUseCase.execute(id, dto);
    if (!entity) throw new NotFoundException(`SeaFreight ${id} not found`);
    return entity;
  }

  @ApiOperation({ summary: 'Delete sea_freight', operationId: 'deleteSeaFreight' })
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
