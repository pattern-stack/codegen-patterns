
import { Injectable } from '@nestjs/common';
import { SyncCursorService } from '../sync-cursor.service';
import type { CreateSyncCursorDto } from '../dto/create-sync-cursor.dto';
import type { SyncCursor } from '../sync-cursor.entity';

@Injectable()
export class CreateSyncCursorUseCase {
  constructor(private readonly service: SyncCursorService) {}

  async execute(
    dto: CreateSyncCursorDto,
  ): Promise<SyncCursor> {
    return this.service.create(dto);
  }
}
