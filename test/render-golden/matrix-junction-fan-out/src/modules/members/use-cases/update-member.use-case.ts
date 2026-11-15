
import { Injectable } from '@nestjs/common';
import { MemberService } from '../member.service';
import type { UpdateMemberDto } from '../dto/update-member.dto';
import type { Member } from '../member.entity';

@Injectable()
export class UpdateMemberUseCase {
  constructor(private readonly service: MemberService) {}

  async execute(
    id: string,
    dto: UpdateMemberDto,
  ): Promise<Member | null> {
    return this.service.update(id, dto);
  }
}
