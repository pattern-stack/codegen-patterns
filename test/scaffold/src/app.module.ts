import { Module } from '@nestjs/common';
import { DatabaseModule } from '../shared/database/database.module';
import { ScaffoldContactsModule } from './contacts/scaffold-contacts.module';

/**
 * AppModule — root module for the scaffold test harness.
 *
 * DatabaseModule must come first — it is @Global() and provides the DRIZZLE
 * injection token that ContactRepository (and thus all generated providers) depend on.
 *
 * ScaffoldContactsModule assembles generated providers (ContactRepository,
 * ContactService, use cases) with hand-written write use cases and a full-CRUD
 * controller, proving the codegen output compiles and wires up correctly.
 */
@Module({
  imports: [DatabaseModule, ScaffoldContactsModule],
})
export class AppModule {}
