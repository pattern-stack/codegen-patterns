
import { Injectable } from '@nestjs/common';
import { SyncCursorService } from '../sync-cursor.service';
import type { UpdateSyncCursorDto } from '../dto/update-sync-cursor.dto';
import type { SyncCursor } from '../sync-cursor.entity';

@Injectable()
export class UpdateSyncCursorUseCase {
  constructor(private readonly service: SyncCursorService) {}

  async execute(
    id: string,
    dto: UpdateSyncCursorDto,
  ): Promise<SyncCursor | null> {
    return this.service.update(id, dto);
  }
}
