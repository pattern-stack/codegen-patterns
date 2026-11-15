
import { BadRequestException, Controller, Get, Post, Patch, Delete, Body, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ZodValidationPipe } from '@shared/pipes/zod-validation.pipe';
import type { Page } from '@shared/http/page';
import { ListParcelsQuerySchema } from './dto/list-parcels.query';
import type { ListParcelsQueryDto } from './dto/list-parcels.query';
import { FindParcelByIdUseCase } from './use-cases/find-parcel-by-id.use-case';
import { ListParcelsUseCase } from './use-cases/list-parcels.use-case';
import { CreateParcelUseCase } from './use-cases/create-parcel.use-case';
import { UpdateParcelUseCase } from './use-cases/update-parcel.use-case';
import { DeleteParcelUseCase } from './use-cases/delete-parcel.use-case';
import { CreateParcelSchema } from './dto/create-parcel.dto';
import type { CreateParcelDto } from './dto/create-parcel.dto';
import { UpdateParcelSchema } from './dto/update-parcel.dto';
import type { UpdateParcelDto } from './dto/update-parcel.dto';
import type { Parcel } from './parcel.entity';
// REL-2 (#587): the HTTP include allowlist (charter I6). A client sends dot
// PATHS; this controller looks each one up in a compile-time literal map and
// merges the fragments. It never builds an include tree from client input, and a
// path the allowlist does not name is a 400.
import {
  IncludeNotAllowedError,
  resolveAllowedInclude,
} from '@shared/http/includes';
import type { ParcelApiResult } from './parcel.repository';

// OPENAPI-3: decorators reference registered schemas by `$ref` because
// the DTOs are Zod-derived types (OPENAPI-2 registers them by name at
// onModuleInit). `ErrorResponseDto` is auto-registered by the shared
// registry.
@ApiBearerAuth()
@Controller('parcels')
export class ParcelController {
  constructor(
    // All routes go through use cases (ADR-003 — no controller → service shortcuts)
    private readonly findByIdUseCase: FindParcelByIdUseCase,
    private readonly listUseCase: ListParcelsUseCase,
    private readonly createUseCase: CreateParcelUseCase,
    private readonly updateUseCase: UpdateParcelUseCase,
    private readonly deleteUseCase: DeleteParcelUseCase,
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

  @ApiOperation({ summary: 'List parcels', operationId: 'listParcels' })
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
        items: { type: 'array', items: { $ref: '#/components/schemas/ParcelOutputDto' } },
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
    @Query(new ZodValidationPipe(ListParcelsQuerySchema)) query: ListParcelsQueryDto,
    @Query('include') include?: string,
  ): Promise<Page<ParcelApiResult>> {
    return this.listUseCase.execute(query, {
      include: this.resolveInclude(include, undefined),
    });
  }

  @ApiOperation({ summary: 'Find parcel by id', operationId: 'findParcelById' })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/ParcelOutputDto' } })
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
  ): Promise<ParcelApiResult> {
    // Use case throws NotFoundException on null/undefined (D2)
    return this.findByIdUseCase.execute(
      id,
      this.resolveInclude(include, undefined),
    );
  }


  @ApiOperation({ summary: 'Create parcel', operationId: 'createParcel' })
  @ApiBody({ schema: { $ref: '#/components/schemas/CreateParcelDto' } })
  @ApiResponse({ status: 201, schema: { $ref: '#/components/schemas/ParcelOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @Post()
  async create(
    @Body(new ZodValidationPipe(CreateParcelSchema)) dto: CreateParcelDto,
  ): Promise<Parcel> {
    return this.createUseCase.execute(dto);
  }

  @ApiOperation({ summary: 'Update parcel', operationId: 'updateParcel' })
  @ApiBody({ schema: { $ref: '#/components/schemas/UpdateParcelDto' } })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/ParcelOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateParcelSchema)) dto: UpdateParcelDto,
  ): Promise<Parcel> {
    const entity = await this.updateUseCase.execute(id, dto);
    if (!entity) throw new NotFoundException(`Parcel ${id} not found`);
    return entity;
  }

  @ApiOperation({ summary: 'Delete parcel', operationId: 'deleteParcel' })
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
