---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.controller : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' %>"
force: true
---
import { Controller, Get<% if (generateWrites) { %>, Post, Patch, Delete, Body<% } %>, Param } from '@nestjs/common';
import { <%= classNames.findByIdUseCase %> } from './use-cases/find-<%= entityName %>-by-id.use-case';
import { <%= classNames.listUseCase %> } from './use-cases/list-<%= entityNamePlural %>.use-case';
<% if (generateWrites) { -%>
import { <%= classNames.createUseCase %> } from './use-cases/create-<%= entityName %>.use-case';
import { <%= classNames.updateUseCase %> } from './use-cases/update-<%= entityName %>.use-case';
import { <%= classNames.deleteUseCase %> } from './use-cases/delete-<%= entityName %>.use-case';
import type { <%= classNames.createDto %> } from './dto/create-<%= entityName %>.dto';
import type { <%= classNames.updateDto %> } from './dto/update-<%= entityName %>.dto';
<% } -%>
import type { <%= classNames.entity %> } from './<%= entityName %>.entity';

@Controller('<%= entityNamePlural %>')
export class <%= classNames.controller %> {
  constructor(
    // All routes go through use cases (ADR-003 — no controller → service shortcuts)
    private readonly findByIdUseCase: <%= classNames.findByIdUseCase %>,
    private readonly listUseCase: <%= classNames.listUseCase %>,
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

  @Get(':id')
  async getById(@Param('id') id: string): Promise<<%= classNames.entity %> | null> {
    return this.findByIdUseCase.execute(id);
  }
<% if (generateWrites) { %>
  @Post()
  async create(@Body() dto: <%= classNames.createDto %>): Promise<<%= classNames.entity %>> {
    return this.createUseCase.execute(dto);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: <%= classNames.updateDto %>,
  ): Promise<<%= classNames.entity %> | null> {
    return this.updateUseCase.execute(id, dto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<<%= classNames.entity %> | null> {
    return this.deleteUseCase.execute(id);
  }
<% } %>
}
