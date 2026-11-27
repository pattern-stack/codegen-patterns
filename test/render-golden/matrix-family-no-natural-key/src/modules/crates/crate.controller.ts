
import { BadRequestException, Controller, Get, Post, Patch, Delete, Body, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ZodValidationPipe } from '@shared/pipes/zod-validation.pipe';
import type { Page } from '@shared/http/page';
import { ListCratesQuerySchema } from './dto/list-crates.query';
import type { ListCratesQueryDto } from './dto/list-crates.query';
import { FindCrateByIdUseCase } from './use-cases/find-crate-by-id.use-case';
import { ListCratesUseCase } from './use-cases/list-crates.use-case';
import { CreateCrateUseCase } from './use-cases/create-crate.use-case';
import { UpdateCrateUseCase } from './use-cases/update-crate.use-case';
import { DeleteCrateUseCase } from './use-cases/delete-crate.use-case';
import { CreateCrateSchema } from './dto/create-crate.dto';
import type { CreateCrateDto } from './dto/create-crate.dto';
import { UpdateCrateSchema } from './dto/update-crate.dto';
import type { UpdateCrateDto } from './dto/update-crate.dto';
import type { CrateFlat } from './crate.repository';
// REL-2 (#587): the HTTP include allowlist (charter I6). A client sends dot
// PATHS; this controller looks each one up in a compile-time literal map and
// merges the fragments. It never builds an include tree from client input, and a
// path the allowlist does not name is a 400.
import {
  IncludeNotAllowedError,
  resolveAllowedInclude,
} from '@shared/http/includes';
import type { CrateApiResult } from './crate.repository';

// OPENAPI-3: decorators reference registered schemas by `$ref` because
// the DTOs are Zod-derived types (OPENAPI-2 registers them by name at
// onModuleInit). `ErrorResponseDto` is auto-registered by the shared
// registry.
@ApiBearerAuth()
@Controller('crates')
export class CrateController {
  constructor(
    // All routes go through use cases (ADR-003 — no controller → service shortcuts)
    private readonly findByIdUseCase: FindCrateByIdUseCase,
    private readonly listUseCase: ListCratesUseCase,
    private readonly createUseCase: CreateCrateUseCase,
    private readonly updateUseCase: UpdateCrateUseCase,
    private readonly deleteUseCase: DeleteCrateUseCase,
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

  @ApiOperation({ summary: 'List crates', operationId: 'listCrates' })
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
        items: { type: 'array', items: { $ref: '#/components/schemas/CrateOutputDto' } },
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
    @Query(new ZodValidationPipe(ListCratesQuerySchema)) query: ListCratesQueryDto,
    @Query('include') include?: string,
  ): Promise<Page<CrateApiResult>> {
    return this.listUseCase.execute(query, {
      include: this.resolveInclude(include, undefined),
    });
  }

  @ApiOperation({ summary: 'Find crate by id', operationId: 'findCrateById' })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/CrateOutputDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid', example: '00000000-0000-4000-8000-000000000001', description: 'The crate\'s id (from a create or GET /crates response). The example is a placeholder: replace it with a real id before sending.' })
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
  ): Promise<CrateApiResult> {
    // Use case throws NotFoundException on null/undefined (D2)
    return this.findByIdUseCase.execute(
      id,
      this.resolveInclude(include, undefined),
    );
  }


  @ApiOperation({ summary: 'Create crate', operationId: 'createCrate' })
  @ApiBody({ schema: { $ref: '#/components/schemas/CreateCrateDto' } })
  @ApiResponse({ status: 201, schema: { $ref: '#/components/schemas/CrateOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @Post()
  async create(
    @Body(new ZodValidationPipe(CreateCrateSchema)) dto: CreateCrateDto,
  ): Promise<CrateFlat> {
    return this.createUseCase.execute(dto);
  }

  @ApiOperation({ summary: 'Update crate', operationId: 'updateCrate' })
  @ApiBody({ schema: { $ref: '#/components/schemas/UpdateCrateDto' } })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/CrateOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid', example: '00000000-0000-4000-8000-000000000001', description: 'The crate\'s id (from a create or GET /crates response). The example is a placeholder: replace it with a real id before sending.' })
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateCrateSchema)) dto: UpdateCrateDto,
  ): Promise<CrateFlat> {
    const entity = await this.updateUseCase.execute(id, dto);
    if (!entity) throw new NotFoundException(`Crate ${id} not found`);
    return entity;
  }

  @ApiOperation({ summary: 'Delete crate', operationId: 'deleteCrate' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid', example: '00000000-0000-4000-8000-000000000001', description: 'The crate\'s id (from a create or GET /crates response). The example is a placeholder: replace it with a real id before sending.' })
  @Delete(':id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.deleteUseCase.execute(id);
  }

}
