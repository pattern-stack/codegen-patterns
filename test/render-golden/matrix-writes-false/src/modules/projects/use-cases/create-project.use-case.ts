
import { Injectable } from '@nestjs/common';
import { ProjectService } from '../project.service';
import type { CreateProjectDto } from '../dto/create-project.dto';
import type { Project } from '../project.entity';

@Injectable()
export class CreateProjectUseCase {
  constructor(private readonly service: ProjectService) {}

  async execute(
    dto: CreateProjectDto,
  ): Promise<Project> {
    return this.service.create(dto);
  }
}
