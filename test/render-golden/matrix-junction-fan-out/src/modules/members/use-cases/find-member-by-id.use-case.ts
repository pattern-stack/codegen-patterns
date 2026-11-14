
import { Injectable, NotFoundException } from '@nestjs/common';
import { MemberService } from '../member.service';
import type { Member } from '../member.entity';

@Injectable()
export class FindMemberByIdUseCase {
  constructor(private readonly service: MemberService) {}

  async execute(id: string): Promise<Member> {
    const entity = await this.service.findById(id);
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`Member not found: ${id}`);
    }
    return entity;
  }
}
