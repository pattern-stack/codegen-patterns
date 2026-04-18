---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.deleteUseCase : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' || !clpOutputPaths.deleteUseCase %>"
force: true
---
import { Injectable } from '@nestjs/common';
import { <%= classNames.service %> } from '../<%= entityName %>.service';

@Injectable()
export class <%= classNames.deleteUseCase %> {
  constructor(private readonly service: <%= classNames.service %>) {}

  async execute(id: string): Promise<void> {
    return this.service.delete(id);
  }
}
