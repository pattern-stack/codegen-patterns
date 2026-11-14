
import { Injectable, Inject } from '@nestjs/common';
import { DRIZZLE } from '@shared/constants/tokens';
import type { DrizzleClient } from '@shared/types/drizzle';
import { FieldValueService } from '../../field-values/field-value.service';
import { LeadService } from '../lead.service';
import type { UpdateLeadDto } from '../dto/update-lead.dto';
import type { Lead } from '../lead.entity';

/**
 * EAV compound-write use case (ADR-13).
 *
 * Mirrors CreateUseCase: splits `{ fields, ...core }`, updates core columns
 * via LeadService and upserts dynamic fields via
 * FieldValueService.upsertFieldsTransactional in a single transaction.
 * Returns null if the entity was not found.
 */
@Injectable()
export class UpdateLeadUseCase {
  constructor(
    private readonly service: LeadService,
    private readonly fields: FieldValueService,
    @Inject(DRIZZLE) private readonly db: DrizzleClient,
  ) {}

  async execute(
    id: string,
    dto: UpdateLeadDto & { fields?: globalThis.Record<string, unknown> },
  ): Promise<Lead | null> {
    return this.db.transaction(async (tx) => {
      const { fields, ...core } = dto;
      const entity = await this.service.update(id, core as UpdateLeadDto, tx);
      if (!entity) return null;
      if (fields && Object.keys(fields).length > 0) {
        await this.fields.upsertFieldsTransactional(
          'lead',
          entity.id,
          entity.userId,
          fields,
          tx,
        );
      }
      return entity;
    });
  }
}
