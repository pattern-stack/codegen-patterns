
import { Injectable } from '@nestjs/common';
import { AuditEntryService } from '../audit-entry.service';
import type { UpdateAuditEntryDto } from '../dto/update-audit-entry.dto';
import type { AuditEntry } from '../audit-entry.entity';

@Injectable()
export class UpdateAuditEntryUseCase {
  constructor(private readonly service: AuditEntryService) {}

  async execute(
    id: string,
    dto: UpdateAuditEntryDto,
  ): Promise<AuditEntry | null> {
    return this.service.update(id, dto);
  }
}
