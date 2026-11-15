
import { Injectable, NotFoundException } from '@nestjs/common';
import { SkillService } from '../skill.service';
import type { Skill } from '../skill.entity';

@Injectable()
export class FindSkillByIdUseCase {
  constructor(private readonly service: SkillService) {}

  async execute(id: string): Promise<Skill> {
    const entity = await this.service.findById(id);
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`Skill not found: ${id}`);
    }
    return entity;
  }
}
