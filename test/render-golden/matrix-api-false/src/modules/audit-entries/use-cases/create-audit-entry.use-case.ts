
import { Injectable } from '@nestjs/common';
import { AuditEntryService } from '../audit-entry.service';
import type { CreateAuditEntryDto } from '../dto/create-audit-entry.dto';
import type { AuditEntry } from '../audit-entry.entity';

@Injectable()
export class CreateAuditEntryUseCase {
  constructor(private readonly service: AuditEntryService) {}

  async execute(
    dto: CreateAuditEntryDto,
  ): Promise<AuditEntry> {
    return this.service.create(dto);
  }
}
