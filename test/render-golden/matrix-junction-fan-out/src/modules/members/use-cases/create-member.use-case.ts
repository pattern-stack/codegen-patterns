
import { Injectable } from '@nestjs/common';
import { MemberService } from '../member.service';
import type { CreateMemberDto } from '../dto/create-member.dto';
import type { Member } from '../member.entity';

@Injectable()
export class CreateMemberUseCase {
  constructor(private readonly service: MemberService) {}

  async execute(
    dto: CreateMemberDto,
  ): Promise<Member> {
    return this.service.create(dto);
  }
}
