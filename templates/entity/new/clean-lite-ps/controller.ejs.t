---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.controller : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' %>"
force: true
---
import { Controller, Get<% if (generateWrites) { %>, Post, Patch, Delete, Body<% } %>, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import { <%= classNames.findByIdUseCase %> } from './use-cases/find-<%= entityName %>-by-id.use-case';
import { <%= classNames.listUseCase %> } from './use-cases/list-<%= entityNamePlural %>.use-case';
<% if (eavEnabled) { -%>
import { <%= classNames.findByIdWithFieldsUseCase %> } from './use-cases/find-<%= entityName %>-by-id-with-fields.use-case';
import { <%= classNames.listWithFieldsUseCase %> } from './use-cases/list-<%= entityNamePlural %>-with-fields.use-case';
<% } -%>
<% if (generateWrites) { -%>
import { ZodValidationPipe } from '@shared/pipes/zod-validation.pipe';
import { <%= classNames.createUseCase %> } from './use-cases/create-<%= entityName %>.use-case';
import { <%= classNames.updateUseCase %> } from './use-cases/update-<%= entityName %>.use-case';
import { <%= classNames.deleteUseCase %> } from './use-cases/delete-<%= entityName %>.use-case';
import { <%= classNames.createSchema %> } from './dto/create-<%= entityName %>.dto';
import type { <%= classNames.createDto %> } from './dto/create-<%= entityName %>.dto';
import { <%= classNames.updateSchema %> } from './dto/update-<%= entityName %>.dto';
import type { <%= classNames.updateDto %> } from './dto/update-<%= entityName %>.dto';
<% } -%>
import type { <%= classNames.entity %> } from './<%= entityName %>.entity';

@Controller('<%= entityNamePlural %>')
export class <%= classNames.controller %> {
  constructor(
    // All routes go through use cases (ADR-003 — no controller → service shortcuts)
    private readonly findByIdUseCase: <%= classNames.findByIdUseCase %>,
    private readonly listUseCase: <%= classNames.listUseCase %>,
<% if (eavEnabled) { -%>
    private readonly findByIdWithFieldsUseCase: <%= classNames.findByIdWithFieldsUseCase %>,
    private readonly listWithFieldsUseCase: <%= classNames.listWithFieldsUseCase %>,
<% } -%>
<% if (generateWrites) { -%>
    private readonly createUseCase: <%= classNames.createUseCase %>,
    private readonly updateUseCase: <%= classNames.updateUseCase %>,
    private readonly deleteUseCase: <%= classNames.deleteUseCase %>,
<% } -%>
  ) {}

  @Get()
  async getAll(): Promise<<%= classNames.entity %>[]> {
    return this.listUseCase.execute();
  }
<% if (eavEnabled) { %>
  @Get('with-fields')
  async getAllWithFields(): Promise<Array<<%= classNames.entity %> & { fields: Record<string, unknown> }>> {
    return this.listWithFieldsUseCase.execute();
  }
<% } %>
  @Get(':id')
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<<%= classNames.entity %>> {
    // Use case throws NotFoundException on null/undefined (D2)
    return this.findByIdUseCase.execute(id);
  }
<% if (eavEnabled) { %>
  @Get(':id/with-fields')
  async getByIdWithFields(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<<%= classNames.entity %> & { fields: Record<string, unknown> }> {
    const entity = await this.findByIdWithFieldsUseCase.execute(id);
    if (!entity) throw new NotFoundException(`<%= classNames.entity %> ${id} not found`);
    return entity;
  }
<% } %>
<% if (generateWrites) { %>
  @Post()
  async create(
    @Body(new ZodValidationPipe(<%= classNames.createSchema %>)) dto: <%= classNames.createDto %>,
  ): Promise<<%= classNames.entity %>> {
    return this.createUseCase.execute(dto);
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(<%= classNames.updateSchema %>)) dto: <%= classNames.updateDto %>,
  ): Promise<<%= classNames.entity %>> {
    const entity = await this.updateUseCase.execute(id, dto);
    if (!entity) throw new NotFoundException(`<%= classNames.entity %> ${id} not found`);
    return entity;
  }

  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.deleteUseCase.execute(id);
  }
<% } %>
}
