---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.listUseCase : null %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
import { Injectable } from '@nestjs/common';
import { <%= classNames.service %> } from '../<%= entityName %>.service';
import type { <%= classNames.entity %> } from '../<%= entityName %>.entity';

@Injectable()
export class <%= classNames.listUseCase %> {
  constructor(private readonly service: <%= classNames.service %>) {}

  async execute(): Promise<<%= classNames.entity %>[]> {
    return this.service.list();
  }
}
