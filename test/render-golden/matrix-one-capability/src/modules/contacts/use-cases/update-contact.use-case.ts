
import { Injectable } from '@nestjs/common';
import { ContactService } from '../contact.service';
import type { UpdateContactDto } from '../dto/update-contact.dto';
import type { Contact } from '../contact.entity';

@Injectable()
export class UpdateContactUseCase {
  constructor(private readonly service: ContactService) {}

  async execute(
    id: string,
    dto: UpdateContactDto,
  ): Promise<Contact | null> {
    return this.service.update(id, dto);
  }
}
