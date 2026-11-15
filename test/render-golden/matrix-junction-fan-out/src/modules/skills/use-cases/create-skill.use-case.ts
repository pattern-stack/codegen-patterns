
import { Injectable } from '@nestjs/common';
import { SkillService } from '../skill.service';
import type { CreateSkillDto } from '../dto/create-skill.dto';
import type { Skill } from '../skill.entity';

@Injectable()
export class CreateSkillUseCase {
  constructor(private readonly service: SkillService) {}

  async execute(
    dto: CreateSkillDto,
  ): Promise<Skill> {
    return this.service.create(dto);
  }
}
