
import { BadRequestException, Controller, Get, Post, Patch, Delete, Body, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ZodValidationPipe } from '@shared/pipes/zod-validation.pipe';
import type { Page } from '@shared/http/page';
import { ListTotesQuerySchema } from './dto/list-totes.query';
import type { ListTotesQueryDto } from './dto/list-totes.query';
import { FindToteByIdUseCase } from './use-cases/find-tote-by-id.use-case';
import { ListTotesUseCase } from './use-cases/list-totes.use-case';
import { CreateToteUseCase } from './use-cases/create-tote.use-case';
import { UpdateToteUseCase } from './use-cases/update-tote.use-case';
import { DeleteToteUseCase } from './use-cases/delete-tote.use-case';
import { CreateToteSchema } from './dto/create-tote.dto';
import type { CreateToteDto } from './dto/create-tote.dto';
import { UpdateToteSchema } from './dto/update-tote.dto';
import type { UpdateToteDto } from './dto/update-tote.dto';
import type { Tote } from './tote.entity';
// REL-2 (#587): the HTTP include allowlist (charter I6). A client sends dot
// PATHS; this controller looks each one up in a compile-time literal map and
// merges the fragments. It never builds an include tree from client input, and a
// path the allowlist does not name is a 400.
import {
  IncludeNotAllowedError,
  resolveAllowedInclude,
} from '@shared/http/includes';
import type { ToteApiResult } from './tote.repository';

// OPENAPI-3: decorators reference registered schemas by `$ref` because
// the DTOs are Zod-derived types (OPENAPI-2 registers them by name at
// onModuleInit). `ErrorResponseDto` is auto-registered by the shared
// registry.
@ApiBearerAuth()
@Controller('totes')
export class ToteController {
  constructor(
    // All routes go through use cases (ADR-003 — no controller → service shortcuts)
    private readonly findByIdUseCase: FindToteByIdUseCase,
    private readonly listUseCase: ListTotesUseCase,
    private readonly createUseCase: CreateToteUseCase,
    private readonly updateUseCase: UpdateToteUseCase,
    private readonly deleteUseCase: DeleteToteUseCase,
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

  @ApiOperation({ summary: 'List totes', operationId: 'listTotes' })
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
        items: { type: 'array', items: { $ref: '#/components/schemas/ToteOutputDto' } },
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
    @Query(new ZodValidationPipe(ListTotesQuerySchema)) query: ListTotesQueryDto,
    @Query('include') include?: string,
  ): Promise<Page<ToteApiResult>> {
    return this.listUseCase.execute(query, {
      include: this.resolveInclude(include, undefined),
    });
  }

  @ApiOperation({ summary: 'Find tote by id', operationId: 'findToteById' })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/ToteOutputDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid', example: '00000000-0000-4000-8000-000000000001', description: 'The tote\'s id (from a create or GET /totes response). The example is a placeholder: replace it with a real id before sending.' })
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
  ): Promise<ToteApiResult> {
    // Use case throws NotFoundException on null/undefined (D2)
    return this.findByIdUseCase.execute(
      id,
      this.resolveInclude(include, undefined),
    );
  }


  @ApiOperation({ summary: 'Create tote', operationId: 'createTote' })
  @ApiBody({ schema: { $ref: '#/components/schemas/CreateToteDto' } })
  @ApiResponse({ status: 201, schema: { $ref: '#/components/schemas/ToteOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @Post()
  async create(
    @Body(new ZodValidationPipe(CreateToteSchema)) dto: CreateToteDto,
  ): Promise<Tote> {
    return this.createUseCase.execute(dto);
  }

  @ApiOperation({ summary: 'Update tote', operationId: 'updateTote' })
  @ApiBody({ schema: { $ref: '#/components/schemas/UpdateToteDto' } })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/ToteOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid', example: '00000000-0000-4000-8000-000000000001', description: 'The tote\'s id (from a create or GET /totes response). The example is a placeholder: replace it with a real id before sending.' })
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateToteSchema)) dto: UpdateToteDto,
  ): Promise<Tote> {
    const entity = await this.updateUseCase.execute(id, dto);
    if (!entity) throw new NotFoundException(`Tote ${id} not found`);
    return entity;
  }

  @ApiOperation({ summary: 'Delete tote', operationId: 'deleteTote' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid', example: '00000000-0000-4000-8000-000000000001', description: 'The tote\'s id (from a create or GET /totes response). The example is a placeholder: replace it with a real id before sending.' })
  @Delete(':id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.deleteUseCase.execute(id);
  }

}
