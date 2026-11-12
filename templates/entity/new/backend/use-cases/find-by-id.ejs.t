---
to: "<%= outputPaths.findByIdUseCase %>"
force: true
---
<%- generatedBanner %>
import { Injectable, NotFoundException } from '@nestjs/common';
import { <%= classNames.service %> } from '../<%= entityFileStem %>.service';
<% if (includes) { -%>
import type {
  <%= classNames.entity %>Include,
  <%= classNames.entity %>NoInclude,
  <%= classNames.entity %>Result,
} from '../<%= entityFileStem %>.repository';
<% } else { -%>
import type { <%= classNames.entity %> } from '../<%= entityFileStem %>.entity';
<% } -%>

@Injectable()
export class <%= classNames.findByIdUseCase %> {
  constructor(private readonly service: <%= classNames.service %>) {}

<% if (includes) { -%>
  /**
   * `include` is a typed include TREE, not a client string — the controller has
   * already resolved `?include=` against the route's allowlist and rejected
   * anything it does not name (REL-2 §5). An internal caller passes the tree
   * directly and gets the exact nested result type back, because `TWith` is
   * inferred at the call site.
   */
  async execute<TWith extends <%= classNames.entity %>Include = <%= classNames.entity %>NoInclude>(
    id: string,
    include?: TWith,
  ): Promise<<%= classNames.entity %>Result<TWith>> {
    const entity = await this.service.findById<TWith>(
      id,
      include === undefined ? undefined : { with: include },
    );
<% } else { -%>
  async execute(id: string): Promise<<%= classNames.entity %>> {
    const entity = await this.service.findById(id);
<% } -%>
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`<%= classNames.entity %> not found: ${id}`);
    }
    return entity;
  }
}
