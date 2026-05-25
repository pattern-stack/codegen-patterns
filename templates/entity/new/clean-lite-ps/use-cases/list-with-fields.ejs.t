---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.listWithFieldsUseCase : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' || !clpOutputPaths.listWithFieldsUseCase %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
import { Injectable } from '@nestjs/common';
import { <%= classNames.service %> } from '../<%= entityName %>.service';
import type { <%= classNames.entity %> } from '../<%= entityName %>.entity';

@Injectable()
export class <%= classNames.listWithFieldsUseCase %> {
  constructor(private readonly service: <%= classNames.service %>) {}

  async execute(): Promise<Array<<%= classNames.entity %> & { fields: Record<string, unknown> }>> {
    return this.service.listWithFields();
  }
}
