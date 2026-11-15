
import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';
import { ContactsModule } from '../contacts/contacts.module';

import { TeamRepository } from './team.repository';
import { TeamService } from './team.service';
import { TeamController } from './team.controller';
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { CreateTeamSchema } from './dto/create-team.dto';
import { UpdateTeamSchema } from './dto/update-team.dto';
import { TeamOutputSchema } from './dto/team-output.dto';
import { FindTeamByIdUseCase } from './use-cases/find-team-by-id.use-case';
import { ListTeamsUseCase } from './use-cases/list-teams.use-case';
import { CreateTeamUseCase } from './use-cases/create-team.use-case';
import { UpdateTeamUseCase } from './use-cases/update-team.use-case';
import { DeleteTeamUseCase } from './use-cases/delete-team.use-case';

@Module({
  imports: [
    DatabaseModule,
    ContactsModule,
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
  ],
  controllers: [TeamController],
  providers: [
    TeamRepository,
    TeamService,
    FindTeamByIdUseCase,
    ListTeamsUseCase,
    CreateTeamUseCase,
    UpdateTeamUseCase,
    DeleteTeamUseCase,
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [TeamService, TeamRepository],
})
export class TeamsModule implements OnModuleInit {
  // OPENAPI-2: register this entity's Zod schemas with the shared
  // OpenApiRegistry at module init. OPENAPI-4 awaits `build()` at boot
  // to emit the full /docs-json document.
  constructor(
    @Inject(OPENAPI_REGISTRY) private readonly openApi: OpenApiRegistry,
  ) {}

  onModuleInit(): void {
    this.openApi.registerSchema('CreateTeamDto', CreateTeamSchema);
    this.openApi.registerSchema('UpdateTeamDto', UpdateTeamSchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    this.openApi.registerSchema('TeamOutputDto', TeamOutputSchema);
  }
}
