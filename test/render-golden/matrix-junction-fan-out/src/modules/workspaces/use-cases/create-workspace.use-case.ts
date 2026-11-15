
import { Injectable } from '@nestjs/common';
import { WorkspaceService } from '../workspace.service';
import type { CreateWorkspaceDto } from '../dto/create-workspace.dto';
import type { Workspace } from '../workspace.entity';

@Injectable()
export class CreateWorkspaceUseCase {
  constructor(private readonly service: WorkspaceService) {}

  async execute(
    dto: CreateWorkspaceDto,
  ): Promise<Workspace> {
    return this.service.create(dto);
  }
}
