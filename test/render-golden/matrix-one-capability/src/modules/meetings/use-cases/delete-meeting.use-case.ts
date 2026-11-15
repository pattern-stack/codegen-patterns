
import { Injectable } from '@nestjs/common';
import { MeetingService } from '../meeting.service';

@Injectable()
export class DeleteMeetingUseCase {
  constructor(private readonly service: MeetingService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
