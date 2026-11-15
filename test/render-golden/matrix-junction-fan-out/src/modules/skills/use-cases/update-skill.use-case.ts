
import { Injectable } from '@nestjs/common';
import { SkillService } from '../skill.service';
import type { UpdateSkillDto } from '../dto/update-skill.dto';
import type { Skill } from '../skill.entity';

@Injectable()
export class UpdateSkillUseCase {
  constructor(private readonly service: SkillService) {}

  async execute(
    id: string,
    dto: UpdateSkillDto,
  ): Promise<Skill | null> {
    return this.service.update(id, dto);
  }
}
