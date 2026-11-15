
import { Injectable, Inject } from '@nestjs/common';
import { DRIZZLE } from '@shared/constants/tokens';
import type { DrizzleClient } from '@shared/types/drizzle';
import { FieldValueService } from '../../field-values/field-value.service';
import { LeadService } from '../lead.service';
import type { CreateLeadDto } from '../dto/create-lead.dto';
import type { Lead } from '../lead.entity';

/**
 * EAV compound-write use case (ADR-13).
 *
 * Splits `{ fields, ...core }` from the DTO and persists both halves in a
 * single transaction: core columns go to the lead table via
 * LeadService, dynamic `fields` go to `field_values` via
 * FieldValueService.upsertFieldsTransactional (which owns the
 * FieldDefinition lookup internally). Atomicity comes from the shared tx;
 * each service still only writes its own domain.
 */
@Injectable()
export class CreateLeadUseCase {
  constructor(
    private readonly service: LeadService,
    private readonly fields: FieldValueService,
    @Inject(DRIZZLE) private readonly db: DrizzleClient,
  ) {}

  async execute(
    dto: CreateLeadDto & { fields?: globalThis.Record<string, unknown> },
  ): Promise<Lead> {
    return this.db.transaction(async (tx) => {
      const { fields, ...core } = dto;
      const entity = await this.service.create(core as CreateLeadDto, tx);
      if (fields && Object.keys(fields).length > 0) {
        await this.fields.upsertFieldsTransactional(
          'lead',
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
