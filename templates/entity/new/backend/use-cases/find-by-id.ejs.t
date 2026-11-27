---
to: "<%= outputPaths.findByIdUseCase %>"
force: true
---
<%- generatedBanner %>
<% if (plainWiring) { -%>
import { NotFoundError } from '<%= errorsImport %>';
<% } else { -%>
import { Injectable, NotFoundException } from '@nestjs/common';
<% } -%>
import { <%= classNames.service %> } from '../<%= entityFileStem %>.service';
<% if (apiSurface.repository.typedInclude) { -%>
import type {
  <%= classNames.entity %>Include,
  <%= classNames.entity %>NoInclude,
<% if (isInheritanceChild) { -%>
  <%= classNames.entity %>Flat,
<% } else { -%>
  <%= classNames.entity %>Result,
<% } -%>
} from '../<%= entityFileStem %>.repository';
<% } else { -%>
import type { <%= classNames.entity %> } from '../<%= entityFileStem %>.entity';
<% } -%>

<% if (!plainWiring) { -%>
@Injectable()
<% } -%>
export class <%= classNames.findByIdUseCase %> {
  constructor(private readonly service: <%= classNames.service %>) {}

<% if (apiSurface.repository.typedInclude) { -%>
<% if (isInheritanceChild) { -%>
  /**
   * RFC-0006 §3.2, §5: a <%= entityName %> is read FLAT — `findWithBase`, one statement, the base's columns
   * hoisted to the root — so the base relation is never an include. `include` is a typed include TREE, not a client
   * string: the controller already resolved `?include=` against the route's allowlist (REL-2 §5).
   */
  async execute<TWith extends <%= classNames.entity %>Include & { <%= familyChild.relKey %>?: never } = <%= classNames.entity %>NoInclude>(
    id: string,
    include?: TWith,
  ): Promise<<%= classNames.entity %>Flat<TWith>> {
    const entity = await this.service.<%= apiSurface.useCases.find((u) => u.kind === 'find_by_id').calls.method %><TWith>(
      id,
      include === undefined ? undefined : { with: include },
    );
<% } else { -%>
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
<% } -%>
<% } else { -%>
  async execute(id: string): Promise<<%= classNames.entity %>> {
    const entity = await this.service.findById(id);
<% } -%>
    if (entity === null || entity === undefined) {
      throw new <%= plainWiring ? 'NotFoundError' : 'NotFoundException' %>(`<%= classNames.entity %> not found: ${id}`);
    }
    return entity;
  }
}
