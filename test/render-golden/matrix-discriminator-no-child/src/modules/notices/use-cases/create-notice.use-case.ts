
import { Injectable } from '@nestjs/common';
import { NoticeService } from '../notice.service';
import type { CreateNoticeDto } from '../dto/create-notice.dto';
import type { Notice } from '../notice.entity';

@Injectable()
export class CreateNoticeUseCase {
  constructor(private readonly service: NoticeService) {}

  async execute(
    dto: CreateNoticeDto,
  ): Promise<Notice> {
    return this.service.create(dto);
  }
}
