
import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';
import { AccountsModule } from '../accounts/accounts.module';
import { UsersModule } from '../users/users.module';

import { TicketRepository } from './ticket.repository';
import { TicketService } from './ticket.service';
import { TicketController } from './ticket.controller';
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { CreateTicketSchema } from './dto/create-ticket.dto';
import { UpdateTicketSchema } from './dto/update-ticket.dto';
import { TicketOutputSchema } from './dto/ticket-output.dto';
import { FindTicketByIdUseCase } from './use-cases/find-ticket-by-id.use-case';
import { ListTicketsUseCase } from './use-cases/list-tickets.use-case';
import { CreateTicketUseCase } from './use-cases/create-ticket.use-case';
import { UpdateTicketUseCase } from './use-cases/update-ticket.use-case';
import { DeleteTicketUseCase } from './use-cases/delete-ticket.use-case';
import { declarativeQueryClasses } from './use-cases/declarative-queries';

@Module({
  imports: [
    DatabaseModule,
    AccountsModule,
    UsersModule,
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
  ],
  controllers: [TicketController],
  providers: [
    TicketRepository,
    TicketService,
    FindTicketByIdUseCase,
    ListTicketsUseCase,
    CreateTicketUseCase,
    UpdateTicketUseCase,
    DeleteTicketUseCase,
    ...declarativeQueryClasses,
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [TicketService, TicketRepository],
})
export class TicketsModule implements OnModuleInit {
  // OPENAPI-2: register this entity's Zod schemas with the shared
  // OpenApiRegistry at module init. OPENAPI-4 awaits `build()` at boot
  // to emit the full /docs-json document.
  constructor(
    @Inject(OPENAPI_REGISTRY) private readonly openApi: OpenApiRegistry,
  ) {}

  onModuleInit(): void {
    this.openApi.registerSchema('CreateTicketDto', CreateTicketSchema);
    this.openApi.registerSchema('UpdateTicketDto', UpdateTicketSchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    this.openApi.registerSchema('TicketOutputDto', TicketOutputSchema);
  }
}
