/**
 * ContactsFullController — scaffold controller with full CRUD routes.
 *
 * The generated ContactsController only has GET routes (read-only by design).
 * This scaffold controller adds POST/PUT/DELETE to exercise the full stack.
 * It overrides the route prefix 'contacts' and is registered in ScaffoldContactsModule
 * in place of the generated controller.
 */
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FindContactByIdUseCase } from '@gen/modules/contacts/use-cases/find-contact-by-id.use-case';
import { ListContactsUseCase } from '@gen/modules/contacts/use-cases/list-contacts.use-case';
import type { Contact, ContactInsert } from '@gen/modules/contacts/contact.entity';
import { CreateContactUseCase } from './create-contact.use-case';
import { UpdateContactUseCase } from './update-contact.use-case';
import { DeleteContactUseCase } from './delete-contact.use-case';

@Controller('contacts')
export class ContactsFullController {
  constructor(
    private readonly findByIdUseCase: FindContactByIdUseCase,
    private readonly listUseCase: ListContactsUseCase,
    private readonly createUseCase: CreateContactUseCase,
    private readonly updateUseCase: UpdateContactUseCase,
    private readonly deleteUseCase: DeleteContactUseCase,
  ) {}

  @Get()
  async getAll(): Promise<Contact[]> {
    return this.listUseCase.execute();
  }

  @Get(':id')
  async getById(@Param('id') id: string): Promise<Contact | null> {
    return this.findByIdUseCase.execute(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: Omit<ContactInsert, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
  ): Promise<Contact> {
    return this.createUseCase.execute(body);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() body: Partial<Contact>,
  ): Promise<Contact | null> {
    return this.updateUseCase.execute(id, body);
  }

  @Delete(':id')
  async delete(@Param('id') id: string): Promise<Contact | null> {
    return this.deleteUseCase.execute(id);
  }
}
