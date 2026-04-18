---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.createUseCase : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' || !clpOutputPaths.createUseCase %>"
force: true
---
import { Injectable } from '@nestjs/common';
import { <%= classNames.service %> } from '../<%= entityName %>.service';
import type { <%= classNames.createDto %> } from '../dto/create-<%= entityName %>.dto';
import type { <%= classNames.entity %> } from '../<%= entityName %>.entity';

@Injectable()
export class <%= classNames.createUseCase %> {
  constructor(private readonly service: <%= classNames.service %>) {}

  async execute(dto: <%= classNames.createDto %>): Promise<<%= classNames.entity %>> {
    return this.service.create(dto);
  }
}
