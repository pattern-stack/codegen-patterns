---
to: "<%= outputPaths.listUseCase %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
import { Injectable } from '@nestjs/common';
import { <%= classNames.service %> } from '../<%= name %>.service';
import type { <%= classNames.entity %> } from '../<%= name %>.entity';

@Injectable()
export class <%= classNames.listUseCase %> {
  constructor(private readonly service: <%= classNames.service %>) {}

  async execute(): Promise<<%= classNames.entity %>[]> {
    return this.service.list();
  }
}
