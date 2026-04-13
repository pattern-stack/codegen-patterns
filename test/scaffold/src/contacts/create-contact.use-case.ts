/**
 * CreateContactUseCase — hand-written write use case for scaffold validation.
 *
 * In production, write use cases are hand-written per ADR-003.
 * This scaffold implementation demonstrates the pattern.
 */
import { Injectable } from '@nestjs/common';
import { ContactService } from '@gen/modules/contacts/contact.service';
import type { Contact, ContactInsert } from '@gen/modules/contacts/contact.entity';

@Injectable()
export class CreateContactUseCase {
  constructor(private readonly service: ContactService) {}

  async execute(data: Omit<ContactInsert, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>): Promise<Contact> {
    return this.service.create(data);
  }
}
