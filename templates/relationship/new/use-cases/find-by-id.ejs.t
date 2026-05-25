---
to: "<%= outputPaths.findByIdUseCase %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
import { Injectable } from '@nestjs/common';
import { <%= classNames.service %> } from '../<%= name %>.service';
import type { <%= classNames.entity %> } from '../<%= name %>.entity';

@Injectable()
export class <%= classNames.findByIdUseCase %> {
  constructor(private readonly service: <%= classNames.service %>) {}

  async execute(id: string): Promise<<%= classNames.entity %> | null> {
    return this.service.findById(id);
  }
}
