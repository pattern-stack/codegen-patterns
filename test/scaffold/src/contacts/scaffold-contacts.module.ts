/**
 * ScaffoldContactsModule — assembles generated providers with a full-CRUD controller.
 *
 * WHY NOT import ContactsModule directly:
 *   The generated ContactsModule registers ContactsController (read-only GET routes).
 *   Adding a second controller for the same /contacts prefix would cause route conflicts.
 *   Instead, this module imports the generated providers individually, which validates
 *   that they compile and inject correctly without duplicating the route prefix.
 *
 * This module exercises:
 *   - ContactRepository (generated) — injects DRIZZLE, extends BaseRepository
 *   - ContactService (generated) — injects repository, extends BaseService
 *   - FindContactByIdUseCase (generated) — injects service
 *   - ListContactsUseCase (generated) — injects service
 *   - Write use cases (hand-written) — injects service
 *   - ContactsFullController (hand-written) — injects all use cases
 */
import { Module } from '@nestjs/common';
import { ContactRepository } from '@gen/modules/contacts/contact.repository';
import { ContactService } from '@gen/modules/contacts/contact.service';
import { FindContactByIdUseCase } from '@gen/modules/contacts/use-cases/find-contact-by-id.use-case';
import { ListContactsUseCase } from '@gen/modules/contacts/use-cases/list-contacts.use-case';
import { ContactsFullController } from './contacts-full.controller';
import { CreateContactUseCase } from './create-contact.use-case';
import { UpdateContactUseCase } from './update-contact.use-case';
import { DeleteContactUseCase } from './delete-contact.use-case';

@Module({
  controllers: [ContactsFullController],
  providers: [
    // Generated providers (validated by compilation)
    ContactRepository,
    ContactService,
    FindContactByIdUseCase,
    ListContactsUseCase,
    // Hand-written write use cases
    CreateContactUseCase,
    UpdateContactUseCase,
    DeleteContactUseCase,
  ],
})
export class ScaffoldContactsModule {}
