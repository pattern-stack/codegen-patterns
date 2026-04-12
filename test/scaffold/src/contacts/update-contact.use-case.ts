/**
 * UpdateContactUseCase — hand-written write use case for scaffold validation.
 */
import { Injectable } from '@nestjs/common';
import { ContactService } from '@gen/modules/contacts/contact.service';
import type { Contact } from '@gen/modules/contacts/contact.entity';

@Injectable()
export class UpdateContactUseCase {
  constructor(private readonly service: ContactService) {}

  async execute(id: string, data: Partial<Contact>): Promise<Contact | null> {
    return this.service.update(id, data);
  }
}
