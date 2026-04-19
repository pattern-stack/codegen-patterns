---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.findByIdUseCase : null %>"
force: true
---
import { Injectable, NotFoundException } from '@nestjs/common';
import { <%= classNames.service %> } from '../<%= entityName %>.service';
import type { <%= classNames.entity %> } from '../<%= entityName %>.entity';

@Injectable()
export class <%= classNames.findByIdUseCase %> {
  constructor(private readonly service: <%= classNames.service %>) {}

  async execute(id: string): Promise<<%= classNames.entity %>> {
    const entity = await this.service.findById(id);
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`<%= classNames.entity %> not found: ${id}`);
    }
    return entity;
  }
}
