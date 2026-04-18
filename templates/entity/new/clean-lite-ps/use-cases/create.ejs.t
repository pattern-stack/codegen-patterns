---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.createUseCase : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' || !clpOutputPaths.createUseCase %>"
force: true
---
<% if (eavEnabled) { -%>
import { Injectable, Inject } from '@nestjs/common';
import { DRIZZLE_DB } from '@shared/constants/tokens';
import type { DrizzleDB } from '@shared/database/drizzle.types';
import { FieldValueService } from '../../field_values/field_value.service';
import { <%= classNames.service %> } from '../<%= entityName %>.service';
import type { <%= classNames.createDto %> } from '../dto/create-<%= entityName %>.dto';
import type { <%= classNames.entity %> } from '../<%= entityName %>.entity';

/**
 * EAV compound-write use case (ADR-13).
 *
 * Splits `{ fields, ...core }` from the DTO and persists both halves in a
 * single transaction: core columns go to the <%= entityName %> table via
 * <%= classNames.service %>, dynamic `fields` go to `field_values` via
 * FieldValueService.upsertFieldsTransactional (which owns the
 * FieldDefinition lookup internally). Atomicity comes from the shared tx;
 * each service still only writes its own domain.
 */
@Injectable()
export class <%= classNames.createUseCase %> {
  constructor(
    private readonly <%= entityNamePlural %>: <%= classNames.service %>,
    private readonly fields: FieldValueService,
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
  ) {}

  async execute(
    dto: <%= classNames.createDto %> & { fields?: Record<string, unknown> },
  ): Promise<<%= classNames.entity %>> {
    return this.db.transaction(async (tx) => {
      const { fields, ...core } = dto;
      const entity = await this.<%= entityNamePlural %>.create(core as <%= classNames.createDto %>, tx);
      if (fields && Object.keys(fields).length > 0) {
        await this.fields.upsertFieldsTransactional(
          '<%= entityName %>',
          entity.id,
          core.userId,
          fields,
          tx,
        );
      }
      return entity;
    });
  }
}
<% } else { -%>
import { Injectable } from '@nestjs/common';
import { <%= classNames.service %> } from '../<%= entityName %>.service';
import type { <%= classNames.createDto %> } from '../dto/create-<%= entityName %>.dto';
import type { <%= classNames.entity %> } from '../<%= entityName %>.entity';

@Injectable()
export class <%= classNames.createUseCase %> {
  constructor(private readonly service: <%= classNames.service %>) {}

  async execute(dto: <%= classNames.createDto %>): Promise<<%= classNames.entity %>> {
    return this.service.create(dto);
  }
}
<% } -%>
