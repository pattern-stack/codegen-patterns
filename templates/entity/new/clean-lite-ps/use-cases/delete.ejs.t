---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.deleteUseCase : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' || !clpOutputPaths.deleteUseCase %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
<% if (hasEmits && deleteEventType) { -%>
import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { DRIZZLE } from '<%= drizzleTokenImport %>';
import type { DrizzleClient } from '<%= drizzleTypeImport %>';
import { TYPED_EVENT_BUS, TypedEventBus } from '<%= eventsTokenImport %>';
import { tryGetRequester } from '<%= tenantContextImport %>';
import { <%= classNames.service %> } from '../<%= entityName %>.service';

/**
 * EXTENSION POINT (EVT-7): verify payload mapping against
 * events/<%= deleteEventType.type %>.yaml before shipping.
 */
@Injectable()
export class <%= classNames.deleteUseCase %> {
  constructor(
    private readonly service: <%= classNames.service %>,
    @Inject(DRIZZLE) private readonly db: DrizzleClient,
    @Inject(TYPED_EVENT_BUS) private readonly typedEvents: TypedEventBus,
  ) {}

  async execute(
    id: string,
  ): Promise<void> {
    const requester = tryGetRequester();
    return this.db.transaction(async (tx) => {
      const entity = await this.service.findById(id);
      if (!entity) {
        throw new NotFoundException(`<%= classNames.entity %> with id ${id} not found`);
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
import { Injectable } from '@nestjs/common';
import { <%= classNames.service %> } from '../<%= entityName %>.service';

@Injectable()
export class <%= classNames.deleteUseCase %> {
  constructor(private readonly service: <%= classNames.service %>) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
<% } -%>
