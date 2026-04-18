---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.updateUseCase : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' || !clpOutputPaths.updateUseCase %>"
force: true
---
<% if (eavEnabled) { -%>
import { Injectable, Inject } from '@nestjs/common';
import { DRIZZLE_DB } from '@shared/constants/tokens';
import type { DrizzleDB } from '@shared/database/drizzle.types';
import { toEavRows } from '@shared/eav-helpers';
import { FieldValueService } from '../../field_values/field_value.service';
import { <%= classNames.service %> } from '../<%= entityName %>.service';
import type { <%= classNames.updateDto %> } from '../dto/update-<%= entityName %>.dto';
import type { <%= classNames.entity %> } from '../<%= entityName %>.entity';

/**
 * EAV compound-write use case (ADR-13).
 *
 * Mirrors CreateUseCase: splits `{ fields, ...core }`, updates core columns
 * via <%= classNames.service %> and upserts dynamic fields via
 * FieldValueService in a single transaction. Returns null if the entity
 * was not found (service.update contract).
 */
@Injectable()
export class <%= classNames.updateUseCase %> {
  constructor(
    private readonly <%= entityName %>s: <%= classNames.service %>,
    private readonly fields: FieldValueService,
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
  ) {}

  async execute(
    id: string,
    dto: <%= classNames.updateDto %> & { fields?: Record<string, unknown> },
  ): Promise<<%= classNames.entity %> | null> {
    return this.db.transaction(async (tx) => {
      const { fields, ...core } = dto;
      const entity = await this.<%= entityName %>s.update(id, core as <%= classNames.updateDto %>, tx);
      if (!entity) return null;
      if (fields && Object.keys(fields).length > 0) {
        await this.fields.upsertMany(toEavRows(entity.id, '<%= entityName %>', fields), tx);
      }
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

  async execute(id: string, dto: <%= classNames.updateDto %>): Promise<<%= classNames.entity %> | null> {
    return this.service.update(id, dto);
  }
}
<% } -%>
