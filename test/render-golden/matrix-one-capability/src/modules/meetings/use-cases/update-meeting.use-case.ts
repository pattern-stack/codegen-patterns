
import { Injectable } from '@nestjs/common';
import { MeetingService } from '../meeting.service';
import type { UpdateMeetingDto } from '../dto/update-meeting.dto';
import type { Meeting } from '../meeting.entity';

@Injectable()
export class UpdateMeetingUseCase {
  constructor(private readonly service: MeetingService) {}

  async execute(
    id: string,
    dto: UpdateMeetingDto,
  ): Promise<Meeting | null> {
    return this.service.update(id, dto);
  }
}
