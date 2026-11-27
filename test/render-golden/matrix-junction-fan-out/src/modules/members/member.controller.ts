
import { BadRequestException, Controller, Get, Post, Patch, Delete, Body, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ZodValidationPipe } from '@shared/pipes/zod-validation.pipe';
import type { Page } from '@shared/http/page';
import { ListMembersQuerySchema } from './dto/list-members.query';
import type { ListMembersQueryDto } from './dto/list-members.query';
import { FindMemberByIdUseCase } from './use-cases/find-member-by-id.use-case';
import { ListMembersUseCase } from './use-cases/list-members.use-case';
import { CreateMemberUseCase } from './use-cases/create-member.use-case';
import { UpdateMemberUseCase } from './use-cases/update-member.use-case';
import { DeleteMemberUseCase } from './use-cases/delete-member.use-case';
import { CreateMemberSchema } from './dto/create-member.dto';
import type { CreateMemberDto } from './dto/create-member.dto';
import { UpdateMemberSchema } from './dto/update-member.dto';
import type { UpdateMemberDto } from './dto/update-member.dto';
import type { Member } from './member.entity';
// REL-2 (#587): the HTTP include allowlist (charter I6). A client sends dot
// PATHS; this controller looks each one up in a compile-time literal map and
// merges the fragments. It never builds an include tree from client input, and a
// path the allowlist does not name is a 400.
import {
  IncludeNotAllowedError,
  resolveAllowedInclude,
} from '@shared/http/includes';
import type { MemberApiResult } from './member.repository';

// OPENAPI-3: decorators reference registered schemas by `$ref` because
// the DTOs are Zod-derived types (OPENAPI-2 registers them by name at
// onModuleInit). `ErrorResponseDto` is auto-registered by the shared
// registry.
@ApiBearerAuth()
@Controller('members')
export class MemberController {
  constructor(
    // All routes go through use cases (ADR-003 — no controller → service shortcuts)
    private readonly findByIdUseCase: FindMemberByIdUseCase,
    private readonly listUseCase: ListMembersUseCase,
    private readonly createUseCase: CreateMemberUseCase,
    private readonly updateUseCase: UpdateMemberUseCase,
    private readonly deleteUseCase: DeleteMemberUseCase,
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

  @ApiOperation({ summary: 'List members', operationId: 'listMembers' })
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
        items: { type: 'array', items: { $ref: '#/components/schemas/MemberOutputDto' } },
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
    @Query(new ZodValidationPipe(ListMembersQuerySchema)) query: ListMembersQueryDto,
    @Query('include') include?: string,
  ): Promise<Page<MemberApiResult>> {
    // member has no relations in the generated graph, so there is no
    // include to expose — but the parameter is still VALIDATED, so `?include=`
    // is a 400 here exactly as it is on an un-allowlisted route (charter I6).
    this.resolveInclude(include, undefined);
    return this.listUseCase.execute(query);
  }

  @ApiOperation({ summary: 'Find member by id', operationId: 'findMemberById' })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/MemberOutputDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid', example: '00000000-0000-4000-8000-000000000001', description: 'The member\'s id (from a create or GET /members response). The example is a placeholder: replace it with a real id before sending.' })
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
  ): Promise<MemberApiResult> {
    // Use case throws NotFoundException on null/undefined (D2)
    this.resolveInclude(include, undefined);
    return this.findByIdUseCase.execute(id);
  }


  @ApiOperation({ summary: 'Create member', operationId: 'createMember' })
  @ApiBody({ schema: { $ref: '#/components/schemas/CreateMemberDto' } })
  @ApiResponse({ status: 201, schema: { $ref: '#/components/schemas/MemberOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 409, description: 'A unique value is already taken (code unique_violation).', schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 422, description: 'A foreign key names no existing row (code foreign_key_violation).', schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @Post()
  async create(
    @Body(new ZodValidationPipe(CreateMemberSchema)) dto: CreateMemberDto,
  ): Promise<Member> {
    return this.createUseCase.execute(dto);
  }

  @ApiOperation({ summary: 'Update member', operationId: 'updateMember' })
  @ApiBody({ schema: { $ref: '#/components/schemas/UpdateMemberDto' } })
  @ApiResponse({ status: 200, schema: { $ref: '#/components/schemas/MemberOutputDto' } })
  @ApiResponse({ status: 400, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 409, description: 'A unique value is already taken (code unique_violation).', schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 422, description: 'A foreign key names no existing row (code foreign_key_violation).', schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid', example: '00000000-0000-4000-8000-000000000001', description: 'The member\'s id (from a create or GET /members response). The example is a placeholder: replace it with a real id before sending.' })
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateMemberSchema)) dto: UpdateMemberDto,
  ): Promise<Member> {
    const entity = await this.updateUseCase.execute(id, dto);
    if (!entity) throw new NotFoundException(`Member ${id} not found`);
    return entity;
  }

  @ApiOperation({ summary: 'Delete member', operationId: 'deleteMember' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 401, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 404, schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiResponse({ status: 409, description: 'Another row still references this one (code still_referenced).', schema: { $ref: '#/components/schemas/ErrorResponseDto' } })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid', example: '00000000-0000-4000-8000-000000000001', description: 'The member\'s id (from a create or GET /members response). The example is a placeholder: replace it with a real id before sending.' })
  @Delete(':id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.deleteUseCase.execute(id);
  }

}
