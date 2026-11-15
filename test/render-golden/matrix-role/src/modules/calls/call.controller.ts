
import { BadRequestException, Controller, Get, Post, Patch, Delete, Body, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ZodValidationPipe } from '@shared/pipes/zod-validation.pipe';
import type { Page } from '@shared/http/page';
import { ListCallsQuerySchema } from './dto/list-calls.query';
import type { ListCallsQueryDto } from './dto/list-calls.query';
import { FindCallByIdUseCase } from './use-cases/find-call-by-id.use-case';
import { ListCallsUseCase } from './use-cases/list-calls.use-case';
import { CreateCallUseCase } from './use-cases/create-call.use-case';
import { UpdateCallUseCase } from './use-cases/update-call.use-case';
import { DeleteCallUseCase } from './use-cases/delete-call.use-case';
import { CreateCallSchema } from './dto/create-call.dto';
import type { CreateCallDto } from './dto/create-call.dto';
import { UpdateCallSchema } from './dto/update-call.dto';
import type { UpdateCallDto } from './dto/update-call.dto';
import type { Call } from './call.entity';
// REL-2 (#587): the HTTP include allowlist (charter I6). A client sends dot
// PATHS; this controller looks each one up in a compile-time literal map and
// merges the fragments. It never builds an include tree from client input, and a
// path the allowlist does not name is a 400.
import {
  IncludeNotAllowedError,
  resolveAllowedInclude,
} from '@shared/http/includes';
import type { CallApiResult } from './call.repository';

// OPENAPI-3: decorators reference registered schemas by `$ref` because
// the DTOs are Zod-derived types (OPENAPI-2 registers them by name at
// onModuleInit). `ErrorResponseDto` is auto-registered by the shared
// registry.
@ApiBearerAuth()
@Controller('calls')
export class CallController {
  constructor(
    // All routes go through use cases (ADR-003 — no controller → service shortcuts)
    private readonly findByIdUseCase: FindCallByIdUseCase,
    private readonly listUseCase: ListCallsUseCase,
    private readonly createUseCase: CreateCallUseCase,
    private readonly updateUseCase: UpdateCallUseCase,
    private readonly deleteUseCase: DeleteCallUseCase,
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

  @ApiOperation({ summary: 'List calls', operationId: 'listCalls' })
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
        items: { type: 'array', items: { $ref: '#/components/schemas/CallOutputDto' } },
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
    @Query(new ZodValidationPipe(ListCallsQuerySchema)) query: ListCallsQueryDto,
    @Query('include') include?: string,
  ): Promise<Page<CallApiResult>> {
    return this.listUseCase.execute(query, {
      include: this.resolveInclude(include, undefined),
    });
  }

  @ApiOperation({ summary: 'Find call by id', operationId: 'findCallById' })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/CallOutputDto' } })
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
  ): Promise<CallApiResult> {
    // Use case throws NotFoundException on null/undefined (D2)
    return this.findByIdUseCase.execute(
      id,
      this.resolveInclude(include, undefined),
    );
  }


  @ApiOperation({ summary: 'Create call', operationId: 'createCall' })
  @ApiBody({ schema: { $ref: '#/components/schemas/CreateCallDto' } })
  @ApiResponse({ status: 201, schema: { $ref: '#/components/schemas/CallOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @Post()
  async create(
    @Body(new ZodValidationPipe(CreateCallSchema)) dto: CreateCallDto,
  ): Promise<Call> {
    return this.createUseCase.execute(dto);
  }

  @ApiOperation({ summary: 'Update call', operationId: 'updateCall' })
  @ApiBody({ schema: { $ref: '#/components/schemas/UpdateCallDto' } })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/CallOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateCallSchema)) dto: UpdateCallDto,
  ): Promise<Call> {
    const entity = await this.updateUseCase.execute(id, dto);
    if (!entity) throw new NotFoundException(`Call ${id} not found`);
    return entity;
  }

  @ApiOperation({ summary: 'Delete call', operationId: 'deleteCall' })
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
