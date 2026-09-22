---
to: "<%= outputPaths.findByIdWithFieldsUseCase %>"
skip_if: "<%= !outputPaths.findByIdWithFieldsUseCase %>"
force: true
---
<%- generatedBanner %>
import { Injectable } from '@nestjs/common';
import { <%= classNames.service %> } from '../<%= entityFileStem %>.service';
import type { <%= classNames.entity %> } from '../<%= entityFileStem %>.entity';

@Injectable()
export class <%= classNames.findByIdWithFieldsUseCase %> {
  constructor(private readonly service: <%= classNames.service %>) {}

  async execute(
    id: string,
  ): Promise<(<%= classNames.entity %> & { fields: Record<string, unknown> }) | null> {
    return this.service.findByIdWithFields(id);
  }
}
