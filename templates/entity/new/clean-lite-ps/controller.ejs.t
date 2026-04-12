---
to: <%= clpOutputPaths.controller %>
force: true
---
import { Controller, Get, Param } from '@nestjs/common';
import { <%= classNames.findByIdUseCase %> } from './use-cases/find-<%= entityName %>-by-id.use-case';
import { <%= classNames.listUseCase %> } from './use-cases/list-<%= entityNamePlural %>.use-case';
import type { <%= classNames.entity %> } from './<%= entityName %>.entity';
// Write use cases must be hand-written. Import them here when ready.

@Controller('<%= entityNamePlural %>')
export class <%= classNames.controller %> {
  constructor(
    // All routes go through use cases (ADR-003 — no controller → service shortcuts)
    private readonly findByIdUseCase: <%= classNames.findByIdUseCase %>,
    private readonly listUseCase: <%= classNames.listUseCase %>,
    // TODO: inject hand-written write use cases here
  ) {}

  @Get()
  async getAll(): Promise<<%= classNames.entity %>[]> {
    return this.listUseCase.execute();
  }

  @Get(':id')
  async getById(@Param('id') id: string): Promise<<%= classNames.entity %> | null> {
    return this.findByIdUseCase.execute(id);
  }

  // TODO: Add write routes. Each must call a hand-written use case, not the service.
  // Example:
  // @Post()
  // async create(@Body() dto: Create<%= classNames.entity %>Dto): Promise<<%= classNames.entity %>> {
  //   return this.createUseCase.execute(dto);
  // }
}
