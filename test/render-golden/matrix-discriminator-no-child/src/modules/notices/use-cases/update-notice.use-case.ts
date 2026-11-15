
import { Injectable } from '@nestjs/common';
import { NoticeService } from '../notice.service';
import type { UpdateNoticeDto } from '../dto/update-notice.dto';
import type { Notice } from '../notice.entity';

@Injectable()
export class UpdateNoticeUseCase {
  constructor(private readonly service: NoticeService) {}

  async execute(
    id: string,
    dto: UpdateNoticeDto,
  ): Promise<Notice | null> {
    return this.service.update(id, dto);
  }
}
