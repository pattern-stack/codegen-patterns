
import { BadRequestException, Controller, Get, Post, Patch, Delete, Body, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ZodValidationPipe } from '@shared/pipes/zod-validation.pipe';
import type { Page } from '@shared/http/page';
import { ListShelvesQuerySchema } from './dto/list-shelves.query';
import type { ListShelvesQueryDto } from './dto/list-shelves.query';
import { FindShelfByIdUseCase } from './use-cases/find-shelf-by-id.use-case';
import { ListShelvesUseCase } from './use-cases/list-shelves.use-case';
import { CreateShelfUseCase } from './use-cases/create-shelf.use-case';
import { UpdateShelfUseCase } from './use-cases/update-shelf.use-case';
import { DeleteShelfUseCase } from './use-cases/delete-shelf.use-case';
import { CreateShelfSchema } from './dto/create-shelf.dto';
import type { CreateShelfDto } from './dto/create-shelf.dto';
import { UpdateShelfSchema } from './dto/update-shelf.dto';
import type { UpdateShelfDto } from './dto/update-shelf.dto';
import type { Shelf } from './shelf.entity';
// REL-2 (#587): the HTTP include allowlist (charter I6). A client sends dot
// PATHS; this controller looks each one up in a compile-time literal map and
// merges the fragments. It never builds an include tree from client input, and a
// path the allowlist does not name is a 400.
import {
  IncludeNotAllowedError,
  resolveAllowedInclude,
} from '@shared/http/includes';
import type { ShelfApiResult } from './shelf.repository';

// OPENAPI-3: decorators reference registered schemas by `$ref` because
// the DTOs are Zod-derived types (OPENAPI-2 registers them by name at
// onModuleInit). `ErrorResponseDto` is auto-registered by the shared
// registry.
@ApiBearerAuth()
@Controller('shelves')
export class ShelfController {
  constructor(
    // All routes go through use cases (ADR-003 — no controller → service shortcuts)
    private readonly findByIdUseCase: FindShelfByIdUseCase,
    private readonly listUseCase: ListShelvesUseCase,
    private readonly createUseCase: CreateShelfUseCase,
    private readonly updateUseCase: UpdateShelfUseCase,
    private readonly deleteUseCase: DeleteShelfUseCase,
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

  @ApiOperation({ summary: 'List shelves', operationId: 'listShelfs' })
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
        items: { type: 'array', items: { $ref: '#/components/schemas/ShelfOutputDto' } },
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
    @Query(new ZodValidationPipe(ListShelvesQuerySchema)) query: ListShelvesQueryDto,
    @Query('include') include?: string,
  ): Promise<Page<ShelfApiResult>> {
    // shelf has no relations in the generated graph, so there is no
    // include to expose — but the parameter is still VALIDATED, so `?include=`
    // is a 400 here exactly as it is on an un-allowlisted route (charter I6).
    this.resolveInclude(include, undefined);
    return this.listUseCase.execute(query);
  }

  @ApiOperation({ summary: 'Find shelf by id', operationId: 'findShelfById' })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/ShelfOutputDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid', example: '00000000-0000-4000-8000-000000000001', description: 'The shelf\'s id (from a create or GET /shelves response). The example is a placeholder: replace it with a real id before sending.' })
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
  ): Promise<ShelfApiResult> {
    // Use case throws NotFoundException on null/undefined (D2)
    this.resolveInclude(include, undefined);
    return this.findByIdUseCase.execute(id);
  }


  @ApiOperation({ summary: 'Create shelf', operationId: 'createShelf' })
  @ApiBody({ schema: { $ref: '#/components/schemas/CreateShelfDto' } })
  @ApiResponse({ status: 201, schema: { $ref: '#/components/schemas/ShelfOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 409, description: 'A unique value is already taken (code unique_violation).', schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 422, description: 'A foreign key names no existing row (code foreign_key_violation).', schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @Post()
  async create(
    @Body(new ZodValidationPipe(CreateShelfSchema)) dto: CreateShelfDto,
  ): Promise<Shelf> {
    return this.createUseCase.execute(dto);
  }

  @ApiOperation({ summary: 'Update shelf', operationId: 'updateShelf' })
  @ApiBody({ schema: { $ref: '#/components/schemas/UpdateShelfDto' } })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/ShelfOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 409, description: 'A unique value is already taken (code unique_violation).', schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 422, description: 'A foreign key names no existing row (code foreign_key_violation).', schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid', example: '00000000-0000-4000-8000-000000000001', description: 'The shelf\'s id (from a create or GET /shelves response). The example is a placeholder: replace it with a real id before sending.' })
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateShelfSchema)) dto: UpdateShelfDto,
  ): Promise<Shelf> {
    const entity = await this.updateUseCase.execute(id, dto);
    if (!entity) throw new NotFoundException(`Shelf ${id} not found`);
    return entity;
  }

  @ApiOperation({ summary: 'Delete shelf', operationId: 'deleteShelf' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 409, description: 'Another row still references this one (code still_referenced).', schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid', example: '00000000-0000-4000-8000-000000000001', description: 'The shelf\'s id (from a create or GET /shelves response). The example is a placeholder: replace it with a real id before sending.' })
  @Delete(':id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.deleteUseCase.execute(id);
  }

}
