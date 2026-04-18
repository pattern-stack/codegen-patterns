---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.updateUseCase : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' || !clpOutputPaths.updateUseCase %>"
force: true
---
import { Injectable } from '@nestjs/common';
import { <%= classNames.service %> } from '../<%= entityName %>.service';
import type { <%= classNames.updateDto %> } from '../dto/update-<%= entityName %>.dto';
import type { <%= classNames.entity %> } from '../<%= entityName %>.entity';

@Injectable()
export class <%= classNames.updateUseCase %> {
  constructor(private readonly service: <%= classNames.service %>) {}

  async execute(id: string, dto: <%= classNames.updateDto %>): Promise<<%= classNames.entity %> | null> {
    return this.service.update(id, dto);
  }
}
