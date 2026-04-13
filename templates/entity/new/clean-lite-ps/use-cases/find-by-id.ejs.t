---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.findByIdUseCase : null %>"
force: true
---
import { Injectable } from '@nestjs/common';
import { <%= classNames.service %> } from '../<%= entityName %>.service';
import type { <%= classNames.entity %> } from '../<%= entityName %>.entity';

@Injectable()
export class <%= classNames.findByIdUseCase %> {
  constructor(private readonly service: <%= classNames.service %>) {}

  async execute(id: string): Promise<<%= classNames.entity %> | null> {
    return this.service.findById(id);
  }
}
