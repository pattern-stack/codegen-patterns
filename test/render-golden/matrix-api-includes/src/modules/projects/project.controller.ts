
import { BadRequestException, Controller, Get, Post, Patch, Delete, Body, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ZodValidationPipe } from '@shared/pipes/zod-validation.pipe';
import type { Page } from '@shared/http/page';
import { ListProjectsQuerySchema } from './dto/list-projects.query';
import type { ListProjectsQueryDto } from './dto/list-projects.query';
import { FindProjectByIdUseCase } from './use-cases/find-project-by-id.use-case';
import { ListProjectsUseCase } from './use-cases/list-projects.use-case';
import { CreateProjectUseCase } from './use-cases/create-project.use-case';
import { UpdateProjectUseCase } from './use-cases/update-project.use-case';
import { DeleteProjectUseCase } from './use-cases/delete-project.use-case';
import { CreateProjectSchema } from './dto/create-project.dto';
import type { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectSchema } from './dto/update-project.dto';
import type { UpdateProjectDto } from './dto/update-project.dto';
import type { Project } from './project.entity';
// REL-2 (#587): the HTTP include allowlist (charter I6). A client sends dot
// PATHS; this controller looks each one up in a compile-time literal map and
// merges the fragments. It never builds an include tree from client input, and a
// path the allowlist does not name is a 400.
import {
  IncludeNotAllowedError,
  resolveAllowedInclude,
} from '@shared/http/includes';
import type { ProjectApiResult } from './project.repository';
import { PROJECTS_API_INCLUDES } from '../../generated/api-includes';

// OPENAPI-3: decorators reference registered schemas by `$ref` because
// the DTOs are Zod-derived types (OPENAPI-2 registers them by name at
// onModuleInit). `ErrorResponseDto` is auto-registered by the shared
// registry.
@ApiBearerAuth()
@Controller('projects')
export class ProjectController {
  constructor(
    // All routes go through use cases (ADR-003 — no controller → service shortcuts)
    private readonly findByIdUseCase: FindProjectByIdUseCase,
    private readonly listUseCase: ListProjectsUseCase,
    private readonly createUseCase: CreateProjectUseCase,
    private readonly updateUseCase: UpdateProjectUseCase,
    private readonly deleteUseCase: DeleteProjectUseCase,
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

  @ApiOperation({ summary: 'List projects', operationId: 'listProjects' })
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
      'Comma-separated include paths, written as relation keys (camelCase), allowlisted by api.includes.list in the entity YAML. Anything else is a 400.',
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { $ref: '#/components/schemas/ProjectOutputDto' } },
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
    @Query(new ZodValidationPipe(ListProjectsQuerySchema)) query: ListProjectsQueryDto,
    @Query('include') include?: string,
  ): Promise<Page<ProjectApiResult>> {
    return this.listUseCase.execute(query, {
      include: this.resolveInclude(include, PROJECTS_API_INCLUDES.list),
    });
  }

  @ApiOperation({ summary: 'Find project by id', operationId: 'findProjectById' })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/ProjectOutputDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiQuery({
    name: 'include',
    required: false,
    type: 'string',
    description:
      'Comma-separated include paths, written as relation keys (camelCase), allowlisted by api.includes.find_by_id in the entity YAML. Anything else is a 400.',
  })
  @Get(':id')
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('include') include?: string,
  ): Promise<ProjectApiResult> {
    // Use case throws NotFoundException on null/undefined (D2)
    return this.findByIdUseCase.execute(
      id,
      this.resolveInclude(include, PROJECTS_API_INCLUDES.find_by_id),
    );
  }


  @ApiOperation({ summary: 'Create project', operationId: 'createProject' })
  @ApiBody({ schema: { $ref: '#/components/schemas/CreateProjectDto' } })
  @ApiResponse({ status: 201, schema: { $ref: '#/components/schemas/ProjectOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @Post()
  async create(
    @Body(new ZodValidationPipe(CreateProjectSchema)) dto: CreateProjectDto,
  ): Promise<Project> {
    return this.createUseCase.execute(dto);
  }

  @ApiOperation({ summary: 'Update project', operationId: 'updateProject' })
  @ApiBody({ schema: { $ref: '#/components/schemas/UpdateProjectDto' } })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/ProjectOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateProjectSchema)) dto: UpdateProjectDto,
  ): Promise<Project> {
    const entity = await this.updateUseCase.execute(id, dto);
    if (!entity) throw new NotFoundException(`Project ${id} not found`);
    return entity;
  }

  @ApiOperation({ summary: 'Delete project', operationId: 'deleteProject' })
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
