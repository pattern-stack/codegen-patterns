
import { BadRequestException, Controller, ConflictException, Get, Post, Patch, Delete, Body, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ZodValidationPipe } from '@shared/pipes/zod-validation.pipe';
import type { Page } from '@shared/http/page';
import { ListNoticesQuerySchema } from './dto/list-notices.query';
import type { ListNoticesQueryDto } from './dto/list-notices.query';
import { FindNoticeByIdUseCase } from './use-cases/find-notice-by-id.use-case';
import { ListNoticesUseCase } from './use-cases/list-notices.use-case';
import { CreateNoticeUseCase } from './use-cases/create-notice.use-case';
import { UpdateNoticeUseCase } from './use-cases/update-notice.use-case';
import { DeleteNoticeUseCase } from './use-cases/delete-notice.use-case';
import { CreateNoticeSchema } from './dto/create-notice.dto';
import type { CreateNoticeDto } from './dto/create-notice.dto';
import { UpdateNoticeSchema } from './dto/update-notice.dto';
import type { UpdateNoticeDto } from './dto/update-notice.dto';
import type { Notice } from './notice.entity';
import {
  KindImmutableError,
  KindMismatchError,
  KindRequiresChildError,
} from '@shared/base-classes/inheritance';
// REL-2 (#587): the HTTP include allowlist (charter I6). A client sends dot
// PATHS; this controller looks each one up in a compile-time literal map and
// merges the fragments. It never builds an include tree from client input, and a
// path the allowlist does not name is a 400.
import {
  IncludeNotAllowedError,
  resolveAllowedInclude,
} from '@shared/http/includes';
import type { NoticeApiResult } from './notice.repository';

// OPENAPI-3: decorators reference registered schemas by `$ref` because
// the DTOs are Zod-derived types (OPENAPI-2 registers them by name at
// onModuleInit). `ErrorResponseDto` is auto-registered by the shared
// registry.
@ApiBearerAuth()
@Controller('notices')
export class NoticeController {
  constructor(
    // All routes go through use cases (ADR-003 — no controller → service shortcuts)
    private readonly findByIdUseCase: FindNoticeByIdUseCase,
    private readonly listUseCase: ListNoticesUseCase,
    private readonly createUseCase: CreateNoticeUseCase,
    private readonly updateUseCase: UpdateNoticeUseCase,
    private readonly deleteUseCase: DeleteNoticeUseCase,
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

  @ApiOperation({ summary: 'List notices', operationId: 'listNotices' })
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
        items: { type: 'array', items: { $ref: '#/components/schemas/NoticeOutputDto' } },
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
    @Query(new ZodValidationPipe(ListNoticesQuerySchema)) query: ListNoticesQueryDto,
    @Query('include') include?: string,
  ): Promise<Page<NoticeApiResult>> {
    // notice has no relations in the generated graph, so there is no
    // include to expose — but the parameter is still VALIDATED, so `?include=`
    // is a 400 here exactly as it is on an un-allowlisted route (charter I6).
    this.resolveInclude(include, undefined);
    return this.listUseCase.execute(query);
  }

  @ApiOperation({ summary: 'Find notice by id', operationId: 'findNoticeById' })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/NoticeOutputDto' } })
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
  ): Promise<NoticeApiResult> {
    // Use case throws NotFoundException on null/undefined (D2)
    this.resolveInclude(include, undefined);
    return this.findByIdUseCase.execute(id);
  }


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

  @ApiOperation({ summary: 'Create notice', operationId: 'createNotice' })
  @ApiBody({ schema: { $ref: '#/components/schemas/CreateNoticeDto' } })
  @ApiResponse({ status: 201, schema: { $ref: '#/components/schemas/NoticeOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @Post()
  async create(
    @Body(new ZodValidationPipe(CreateNoticeSchema)) dto: CreateNoticeDto,
  ): Promise<Notice> {
    try {
      return await this.createUseCase.execute(dto);
    } catch (err: unknown) {
      throw this.kindError(err);
    }
  }

  @ApiOperation({ summary: 'Update notice', operationId: 'updateNotice' })
  @ApiBody({ schema: { $ref: '#/components/schemas/UpdateNoticeDto' } })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/NoticeOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateNoticeSchema)) dto: UpdateNoticeDto,
  ): Promise<Notice> {
    let entity: Notice | null;
    try {
      entity = await this.updateUseCase.execute(id, dto);
    } catch (err: unknown) {
      throw this.kindError(err);
    }
    if (!entity) throw new NotFoundException(`Notice ${id} not found`);
    return entity;
  }

  @ApiOperation({ summary: 'Delete notice', operationId: 'deleteNotice' })
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
