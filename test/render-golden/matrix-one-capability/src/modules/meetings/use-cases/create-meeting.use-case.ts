
import { Injectable } from '@nestjs/common';
import { MeetingService } from '../meeting.service';
import type { CreateMeetingDto } from '../dto/create-meeting.dto';
import type { Meeting } from '../meeting.entity';

@Injectable()
export class CreateMeetingUseCase {
  constructor(private readonly service: MeetingService) {}

  async execute(
    dto: CreateMeetingDto,
  ): Promise<Meeting> {
    return this.service.create(dto);
  }
}
