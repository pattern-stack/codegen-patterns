
import { Injectable } from '@nestjs/common';
import { ProjectService } from '../project.service';
import type { UpdateProjectDto } from '../dto/update-project.dto';
import type { Project } from '../project.entity';

@Injectable()
export class UpdateProjectUseCase {
  constructor(private readonly service: ProjectService) {}

  async execute(
    id: string,
    dto: UpdateProjectDto,
  ): Promise<Project | null> {
    return this.service.update(id, dto);
  }
}
