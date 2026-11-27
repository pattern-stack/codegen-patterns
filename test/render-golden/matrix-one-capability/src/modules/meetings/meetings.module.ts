
import { Inject, Module, forwardRef } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';
import { ContactsModule } from '../contacts/contacts.module';

import { MeetingRepository } from './meeting.repository';
import { MeetingService } from './meeting.service';
import { MeetingController } from './meeting.controller';
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { CreateMeetingSchema } from './dto/create-meeting.dto';
import { UpdateMeetingSchema } from './dto/update-meeting.dto';
import { MeetingOutputSchema } from './dto/meeting-output.dto';
import { FindMeetingByIdUseCase } from './use-cases/find-meeting-by-id.use-case';
import { ListMeetingsUseCase } from './use-cases/list-meetings.use-case';
import { CreateMeetingUseCase } from './use-cases/create-meeting.use-case';
import { UpdateMeetingUseCase } from './use-cases/update-meeting.use-case';
import { DeleteMeetingUseCase } from './use-cases/delete-meeting.use-case';

@Module({
  imports: [
    DatabaseModule,
    forwardRef(() => ContactsModule),
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
  ],
  controllers: [MeetingController],
  providers: [
    MeetingRepository,
    MeetingService,
    FindMeetingByIdUseCase,
    ListMeetingsUseCase,
    CreateMeetingUseCase,
    UpdateMeetingUseCase,
    DeleteMeetingUseCase,
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [MeetingService, MeetingRepository],
})
export class MeetingsModule {
  // OPENAPI-2: register this entity's Zod schemas when Nest constructs the
  // module (in `NestFactory.create`), so they are in the registry before
  // main.ts builds /docs-json. A lifecycle hook (`onModuleInit`) runs too late.
  constructor(@Inject(OPENAPI_REGISTRY) openApi: OpenApiRegistry) {
    openApi.registerSchema('CreateMeetingDto', CreateMeetingSchema);
    openApi.registerSchema('UpdateMeetingDto', UpdateMeetingSchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    openApi.registerSchema('MeetingOutputDto', MeetingOutputSchema);
  }
}
