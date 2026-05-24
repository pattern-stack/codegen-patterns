---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.findByIdWithFieldsUseCase : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' || !clpOutputPaths.findByIdWithFieldsUseCase %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
import { Injectable } from '@nestjs/common';
import { <%= classNames.service %> } from '../<%= entityName %>.service';
import type { <%= classNames.entity %> } from '../<%= entityName %>.entity';

@Injectable()
export class <%= classNames.findByIdWithFieldsUseCase %> {
  constructor(private readonly service: <%= classNames.service %>) {}

  async execute(
    id: string,
  ): Promise<(<%= classNames.entity %> & { fields: Record<string, unknown> }) | null> {
    return this.service.findByIdWithFields(id);
  }
}
