
import { Injectable, NotFoundException } from '@nestjs/common';
import { NoticeService } from '../notice.service';
import type { Notice } from '../notice.entity';

@Injectable()
export class FindNoticeByIdUseCase {
  constructor(private readonly service: NoticeService) {}

  async execute(id: string): Promise<Notice> {
    const entity = await this.service.findById(id);
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`Notice not found: ${id}`);
    }
    return entity;
  }
}
