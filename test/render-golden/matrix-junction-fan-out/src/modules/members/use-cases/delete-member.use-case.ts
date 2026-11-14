
import { Injectable } from '@nestjs/common';
import { MemberService } from '../member.service';

@Injectable()
export class DeleteMemberUseCase {
  constructor(private readonly service: MemberService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
