
import { Injectable } from '@nestjs/common';
import { WorkspaceService } from '../workspace.service';
import type { UpdateWorkspaceDto } from '../dto/update-workspace.dto';
import type { Workspace } from '../workspace.entity';

@Injectable()
export class UpdateWorkspaceUseCase {
  constructor(private readonly service: WorkspaceService) {}

  async execute(
    id: string,
    dto: UpdateWorkspaceDto,
  ): Promise<Workspace | null> {
    return this.service.update(id, dto);
  }
}
