---
to: "<%= outputPaths.listWithFieldsUseCase %>"
skip_if: "<%= !outputPaths.listWithFieldsUseCase %>"
force: true
---
<%- generatedBanner %>
import { Injectable } from '@nestjs/common';
import { <%= classNames.service %> } from '../<%= entityFileStem %>.service';
import type { <%= classNames.entity %> } from '../<%= entityFileStem %>.entity';

@Injectable()
export class <%= classNames.listWithFieldsUseCase %> {
  constructor(private readonly service: <%= classNames.service %>) {}

  async execute(): Promise<Array<<%= classNames.entity %> & { fields: Record<string, unknown> }>> {
    return this.service.listWithFields();
  }
}
