---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.updateUseCase : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' || !clpOutputPaths.updateUseCase %>"
force: true
---
<% if (eavEnabled) { -%>
import { Injectable, Inject } from '@nestjs/common';
import { DRIZZLE } from '<%= drizzleTokenImport %>';
import type { DrizzleClient } from '<%= drizzleTypeImport %>';
<% if (hasEmits && updateEventType) { -%>
import { TYPED_EVENT_BUS, TypedEventBus } from '<%= eventsTokenImport %>';
<% } -%>
import { FieldValueService } from '../../field_values/field_value.service';
import { <%= classNames.service %> } from '../<%= entityName %>.service';
import type { <%= classNames.updateDto %> } from '../dto/update-<%= entityName %>.dto';
import type { <%= classNames.entity %> } from '../<%= entityName %>.entity';

/**
 * EAV compound-write use case (ADR-13).
 *
 * Mirrors CreateUseCase: splits `{ fields, ...core }`, updates core columns
 * via <%= classNames.service %> and upserts dynamic fields via
 * FieldValueService.upsertFieldsTransactional in a single transaction.
 * Returns null if the entity was not found.
<% if (hasEmits && updateEventType) { -%>
 *
 * EXTENSION POINT (EVT-7): verify payload mapping against
 * events/<%= updateEventType.type %>.yaml before shipping.
<% } -%>
 */
@Injectable()
export class <%= classNames.updateUseCase %> {
  constructor(
    private readonly <%= entityNamePlural %>: <%= classNames.service %>,
    private readonly fields: FieldValueService,
    @Inject(DRIZZLE) private readonly db: DrizzleClient,
<% if (hasEmits && updateEventType) { -%>
    @Inject(TYPED_EVENT_BUS) private readonly typedEvents: TypedEventBus,
<% } -%>
  ) {}

  async execute(
    id: string,
    dto: <%= classNames.updateDto %> & { fields?: Record<string, unknown> },
    <%= hasEmits && updateEventType ? 'opts' : '_opts' %>?: { actor?: { tenantId?: string | null; userId?: string } },
  ): Promise<<%= classNames.entity %> | null> {
    return this.db.transaction(async (tx) => {
      const { fields, ...core } = dto;
      const entity = await this.<%= entityNamePlural %>.update(id, core as <%= classNames.updateDto %>, tx);
      if (!entity) return null;
      if (fields && Object.keys(fields).length > 0) {
        await this.fields.upsertFieldsTransactional(
          '<%= entityName %>',
          entity.id,
          entity.userId,
          fields,
          tx,
        );
      }
<% if (hasEmits && updateEventType) { -%>
      // TODO: verify payload mapping against events/<%= updateEventType.type %>.yaml
      await this.typedEvents.publish(
        '<%= updateEventType.type %>',
        entity.id,
        {
<% updateEventType.payloadMap.forEach((p) => { -%>
          <%= p.camelKey %>: <%- p.expression %>,<% if (p.todo) { %> // TODO: <%= p.todo %><% } %>

<% }) -%>
        },
        {
          tx,
          metadata: opts?.actor
            ? { tenantId: opts.actor.tenantId, userId: opts.actor.userId }
            : undefined,
        },
      );
<% } -%>
      return entity;
    });
  }
}
<% } else { -%>
<% if (hasEmits && updateEventType) { -%>
import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { DRIZZLE } from '<%= drizzleTokenImport %>';
import type { DrizzleClient } from '<%= drizzleTypeImport %>';
import { TYPED_EVENT_BUS, TypedEventBus } from '<%= eventsTokenImport %>';
import { <%= classNames.service %> } from '../<%= entityName %>.service';
import type { <%= classNames.updateDto %> } from '../dto/update-<%= entityName %>.dto';
import type { <%= classNames.entity %> } from '../<%= entityName %>.entity';

/**
 * EXTENSION POINT (EVT-7): verify payload mapping against
 * events/<%= updateEventType.type %>.yaml before shipping.
 */
@Injectable()
export class <%= classNames.updateUseCase %> {
  constructor(
    private readonly service: <%= classNames.service %>,
    @Inject(DRIZZLE) private readonly db: DrizzleClient,
    @Inject(TYPED_EVENT_BUS) private readonly typedEvents: TypedEventBus,
  ) {}

  async execute(
    id: string,
    dto: <%= classNames.updateDto %>,
    opts?: { actor?: { tenantId?: string | null; userId?: string } },
  ): Promise<<%= classNames.entity %> | null> {
    return this.db.transaction(async (tx) => {
      const entity = await this.service.update(id, dto, tx);
      if (!entity) return null;
      // TODO: verify payload mapping against events/<%= updateEventType.type %>.yaml
      await this.typedEvents.publish(
        '<%= updateEventType.type %>',
        entity.id,
        {
<% updateEventType.payloadMap.forEach((p) => { -%>
          <%= p.camelKey %>: <%- p.expression %>,<% if (p.todo) { %> // TODO: <%= p.todo %><% } %>

<% }) -%>
        },
        {
          tx,
          metadata: opts?.actor
            ? { tenantId: opts.actor.tenantId, userId: opts.actor.userId }
            : undefined,
        },
      );
      return entity;
    });
  }
}
<% } else { -%>
import { Injectable } from '@nestjs/common';
import { <%= classNames.service %> } from '../<%= entityName %>.service';
import type { <%= classNames.updateDto %> } from '../dto/update-<%= entityName %>.dto';
import type { <%= classNames.entity %> } from '../<%= entityName %>.entity';

@Injectable()
export class <%= classNames.updateUseCase %> {
  constructor(private readonly service: <%= classNames.service %>) {}

  async execute(
    id: string,
    dto: <%= classNames.updateDto %>,
    _opts?: { actor?: { tenantId?: string | null; userId?: string } },
  ): Promise<<%= classNames.entity %> | null> {
    return this.service.update(id, dto);
  }
}
<% } -%>
<% } -%>
