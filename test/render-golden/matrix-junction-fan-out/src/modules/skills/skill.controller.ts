
import { BadRequestException, Controller, Get, Post, Patch, Delete, Body, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ZodValidationPipe } from '@shared/pipes/zod-validation.pipe';
import type { Page } from '@shared/http/page';
import { ListSkillsQuerySchema } from './dto/list-skills.query';
import type { ListSkillsQueryDto } from './dto/list-skills.query';
import { FindSkillByIdUseCase } from './use-cases/find-skill-by-id.use-case';
import { ListSkillsUseCase } from './use-cases/list-skills.use-case';
import { CreateSkillUseCase } from './use-cases/create-skill.use-case';
import { UpdateSkillUseCase } from './use-cases/update-skill.use-case';
import { DeleteSkillUseCase } from './use-cases/delete-skill.use-case';
import { CreateSkillSchema } from './dto/create-skill.dto';
import type { CreateSkillDto } from './dto/create-skill.dto';
import { UpdateSkillSchema } from './dto/update-skill.dto';
import type { UpdateSkillDto } from './dto/update-skill.dto';
import type { Skill } from './skill.entity';
// REL-2 (#587): the HTTP include allowlist (charter I6). A client sends dot
// PATHS; this controller looks each one up in a compile-time literal map and
// merges the fragments. It never builds an include tree from client input, and a
// path the allowlist does not name is a 400.
import {
  IncludeNotAllowedError,
  resolveAllowedInclude,
} from '@shared/http/includes';
import type { SkillApiResult } from './skill.repository';

// OPENAPI-3: decorators reference registered schemas by `$ref` because
// the DTOs are Zod-derived types (OPENAPI-2 registers them by name at
// onModuleInit). `ErrorResponseDto` is auto-registered by the shared
// registry.
@ApiBearerAuth()
@Controller('skills')
export class SkillController {
  constructor(
    // All routes go through use cases (ADR-003 — no controller → service shortcuts)
    private readonly findByIdUseCase: FindSkillByIdUseCase,
    private readonly listUseCase: ListSkillsUseCase,
    private readonly createUseCase: CreateSkillUseCase,
    private readonly updateUseCase: UpdateSkillUseCase,
    private readonly deleteUseCase: DeleteSkillUseCase,
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

  @ApiOperation({ summary: 'List skills', operationId: 'listSkills' })
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
        items: { type: 'array', items: { $ref: '#/components/schemas/SkillOutputDto' } },
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
    @Query(new ZodValidationPipe(ListSkillsQuerySchema)) query: ListSkillsQueryDto,
    @Query('include') include?: string,
  ): Promise<Page<SkillApiResult>> {
    // skill has no relations in the generated graph, so there is no
    // include to expose — but the parameter is still VALIDATED, so `?include=`
    // is a 400 here exactly as it is on an un-allowlisted route (charter I6).
    this.resolveInclude(include, undefined);
    return this.listUseCase.execute(query);
  }

  @ApiOperation({ summary: 'Find skill by id', operationId: 'findSkillById' })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/SkillOutputDto' } })
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
  ): Promise<SkillApiResult> {
    // Use case throws NotFoundException on null/undefined (D2)
    this.resolveInclude(include, undefined);
    return this.findByIdUseCase.execute(id);
  }


  @ApiOperation({ summary: 'Create skill', operationId: 'createSkill' })
  @ApiBody({ schema: { $ref: '#/components/schemas/CreateSkillDto' } })
  @ApiResponse({ status: 201, schema: { $ref: '#/components/schemas/SkillOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @Post()
  async create(
    @Body(new ZodValidationPipe(CreateSkillSchema)) dto: CreateSkillDto,
  ): Promise<Skill> {
    return this.createUseCase.execute(dto);
  }

  @ApiOperation({ summary: 'Update skill', operationId: 'updateSkill' })
  @ApiBody({ schema: { $ref: '#/components/schemas/UpdateSkillDto' } })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/SkillOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateSkillSchema)) dto: UpdateSkillDto,
  ): Promise<Skill> {
    const entity = await this.updateUseCase.execute(id, dto);
    if (!entity) throw new NotFoundException(`Skill ${id} not found`);
    return entity;
  }

  @ApiOperation({ summary: 'Delete skill', operationId: 'deleteSkill' })
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
