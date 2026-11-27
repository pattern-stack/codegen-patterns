
import { BadRequestException, Controller, Get, Post, Patch, Delete, Body, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ZodValidationPipe } from '@shared/pipes/zod-validation.pipe';
import type { Page } from '@shared/http/page';
import { ListBinsQuerySchema } from './dto/list-bins.query';
import type { ListBinsQueryDto } from './dto/list-bins.query';
import { FindBinByIdUseCase } from './use-cases/find-bin-by-id.use-case';
import { ListBinsUseCase } from './use-cases/list-bins.use-case';
import { CreateBinUseCase } from './use-cases/create-bin.use-case';
import { UpdateBinUseCase } from './use-cases/update-bin.use-case';
import { DeleteBinUseCase } from './use-cases/delete-bin.use-case';
import { CreateBinSchema } from './dto/create-bin.dto';
import type { CreateBinDto } from './dto/create-bin.dto';
import { UpdateBinSchema } from './dto/update-bin.dto';
import type { UpdateBinDto } from './dto/update-bin.dto';
import type { BinFlat } from './bin.repository';
// REL-2 (#587): the HTTP include allowlist (charter I6). A client sends dot
// PATHS; this controller looks each one up in a compile-time literal map and
// merges the fragments. It never builds an include tree from client input, and a
// path the allowlist does not name is a 400.
import {
  IncludeNotAllowedError,
  resolveAllowedInclude,
} from '@shared/http/includes';
import type { BinApiResult } from './bin.repository';

// OPENAPI-3: decorators reference registered schemas by `$ref` because
// the DTOs are Zod-derived types (OPENAPI-2 registers them by name at
// onModuleInit). `ErrorResponseDto` is auto-registered by the shared
// registry.
@ApiBearerAuth()
@Controller('bins')
export class BinController {
  constructor(
    // All routes go through use cases (ADR-003 — no controller → service shortcuts)
    private readonly findByIdUseCase: FindBinByIdUseCase,
    private readonly listUseCase: ListBinsUseCase,
    private readonly createUseCase: CreateBinUseCase,
    private readonly updateUseCase: UpdateBinUseCase,
    private readonly deleteUseCase: DeleteBinUseCase,
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

  @ApiOperation({ summary: 'List bins', operationId: 'listBins' })
  @ApiQuery({ name: 'page', required: false, type: 'integer', example: 1, description: '1-based page number (default 1).' })
  @ApiQuery({ name: 'pageSize', required: false, type: 'integer', example: 50, description: 'Page size (default 50, max 200).' })
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
        items: { type: 'array', items: { $ref: '#/components/schemas/BinOutputDto' } },
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
    @Query(new ZodValidationPipe(ListBinsQuerySchema)) query: ListBinsQueryDto,
    @Query('include') include?: string,
  ): Promise<Page<BinApiResult>> {
    return this.listUseCase.execute(query, {
      include: this.resolveInclude(include, undefined),
    });
  }

  @ApiOperation({ summary: 'Find bin by id', operationId: 'findBinById' })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/BinOutputDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid', example: '00000000-0000-4000-8000-000000000001', description: 'The bin\'s id (from a create or GET /bins response). The example is a placeholder: replace it with a real id before sending.' })
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
  ): Promise<BinApiResult> {
    // Use case throws NotFoundException on null/undefined (D2)
    return this.findByIdUseCase.execute(
      id,
      this.resolveInclude(include, undefined),
    );
  }


  @ApiOperation({ summary: 'Create bin', operationId: 'createBin' })
  @ApiBody({ schema: { $ref: '#/components/schemas/CreateBinDto' } })
  @ApiResponse({ status: 201, schema: { $ref: '#/components/schemas/BinOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @Post()
  async create(
    @Body(new ZodValidationPipe(CreateBinSchema)) dto: CreateBinDto,
  ): Promise<BinFlat> {
    return this.createUseCase.execute(dto);
  }

  @ApiOperation({ summary: 'Update bin', operationId: 'updateBin' })
  @ApiBody({ schema: { $ref: '#/components/schemas/UpdateBinDto' } })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/BinOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid', example: '00000000-0000-4000-8000-000000000001', description: 'The bin\'s id (from a create or GET /bins response). The example is a placeholder: replace it with a real id before sending.' })
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateBinSchema)) dto: UpdateBinDto,
  ): Promise<BinFlat> {
    const entity = await this.updateUseCase.execute(id, dto);
    if (!entity) throw new NotFoundException(`Bin ${id} not found`);
    return entity;
  }

  @ApiOperation({ summary: 'Delete bin', operationId: 'deleteBin' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid', example: '00000000-0000-4000-8000-000000000001', description: 'The bin\'s id (from a create or GET /bins response). The example is a placeholder: replace it with a real id before sending.' })
  @Delete(':id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.deleteUseCase.execute(id);
  }

}
