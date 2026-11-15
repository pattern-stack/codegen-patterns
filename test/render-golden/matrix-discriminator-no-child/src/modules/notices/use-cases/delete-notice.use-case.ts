
import { Injectable } from '@nestjs/common';
import { NoticeService } from '../notice.service';

@Injectable()
export class DeleteNoticeUseCase {
  constructor(private readonly service: NoticeService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
