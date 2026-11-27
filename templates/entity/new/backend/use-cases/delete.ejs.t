---
to: "<%= outputPaths.deleteUseCase %>"
skip_if: "<%= !outputPaths.deleteUseCase %>"
force: true
---
<%- generatedBanner %>
<% if (hasEmits && deleteEventType) { -%>
<% if (patternStackWiring) { -%>
import { NotFoundError } from '<%= errorsImport %>';
<% } else { -%>
import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { DRIZZLE } from '<%= drizzleTokenImport %>';
<% } -%>
import type { DrizzleClient } from '<%= drizzleTypeImport %>';
<% if (patternStackWiring) { -%>
import type { TypedEventBus } from '<%= typedEventBusImport %>';
<% } else if (typedEventBusImport === eventsTokenImport) { -%>
import { TYPED_EVENT_BUS, TypedEventBus } from '<%= eventsTokenImport %>';
<% } else { -%>
import { TYPED_EVENT_BUS } from '<%= eventsTokenImport %>';
import { TypedEventBus } from '<%= typedEventBusImport %>';
<% } -%>
import { tryGetRequester } from '<%= tenantContextImport %>';
import { <%= classNames.service %> } from '../<%= entityFileStem %>.service';

/**
 * EXTENSION POINT (EVT-7): verify payload mapping against
 * events/<%= deleteEventType.type %>.yaml before shipping.
 */
<% if (!patternStackWiring) { -%>
@Injectable()
<% } -%>
export class <%= classNames.deleteUseCase %> {
  constructor(
    private readonly service: <%= classNames.service %>,
    <%= patternStackWiring ? '' : '@Inject(DRIZZLE) ' %>private readonly db: DrizzleClient,
    <%= patternStackWiring ? '' : '@Inject(TYPED_EVENT_BUS) ' %>private readonly typedEvents: TypedEventBus,
  ) {}

  async execute(
    id: string,
  ): Promise<void> {
    const requester = tryGetRequester();
    return this.db.transaction(async (tx) => {
<% if (isInheritanceChild) { -%>
      // The flat row: the event payload reads base fields too (RFC-0006 §5).
<% } -%>
      const entity = await this.service.<%= apiSurface.useCases.find((u) => u.kind === 'delete').preRead.method %>(id);
      if (!entity) {
        throw new <%= patternStackWiring ? 'NotFoundError' : 'NotFoundException' %>(`<%= classNames.entity %> with id ${id} not found`);
      }
      await this.service.delete(id, tx);
      // TODO: verify payload mapping against events/<%= deleteEventType.type %>.yaml
      await this.typedEvents.publish(
        '<%= deleteEventType.type %>',
        entity.id,
        {
<% deleteEventType.payloadMap.forEach((p) => { -%>
          <%= p.camelKey %>: <%- p.expression %>,<% if (p.todo) { %> // TODO: <%= p.todo %><% } %>

<% }) -%>
        },
        {
          tx,
          metadata: requester ? { userId: requester.userId } : undefined,
        },
      );
    });
  }
}
<% } else { -%>
<% if (!patternStackWiring) { -%>
import { Injectable } from '@nestjs/common';
<% } -%>
import { <%= classNames.service %> } from '../<%= entityFileStem %>.service';

<% if (!patternStackWiring) { -%>
@Injectable()
<% } -%>
export class <%= classNames.deleteUseCase %> {
  constructor(private readonly service: <%= classNames.service %>) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
<% } -%>
