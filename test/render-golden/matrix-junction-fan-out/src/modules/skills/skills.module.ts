
import { Inject, Module, forwardRef } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';
import { MemberSkillsModule } from '../member-skills/member-skills.module';

import { SkillRepository } from './skill.repository';
import { SkillService } from './skill.service';
import { SkillController } from './skill.controller';
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { CreateSkillSchema } from './dto/create-skill.dto';
import { UpdateSkillSchema } from './dto/update-skill.dto';
import { SkillOutputSchema } from './dto/skill-output.dto';
import { FindSkillByIdUseCase } from './use-cases/find-skill-by-id.use-case';
import { ListSkillsUseCase } from './use-cases/list-skills.use-case';
import { CreateSkillUseCase } from './use-cases/create-skill.use-case';
import { UpdateSkillUseCase } from './use-cases/update-skill.use-case';
import { DeleteSkillUseCase } from './use-cases/delete-skill.use-case';

@Module({
  imports: [
    DatabaseModule,
    forwardRef(() => MemberSkillsModule),
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
  ],
  controllers: [SkillController],
  providers: [
    SkillRepository,
    SkillService,
    FindSkillByIdUseCase,
    ListSkillsUseCase,
    CreateSkillUseCase,
    UpdateSkillUseCase,
    DeleteSkillUseCase,
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [SkillService, SkillRepository],
})
export class SkillsModule {
  // OPENAPI-2: register this entity's Zod schemas when Nest constructs the
  // module (in `NestFactory.create`), so they are in the registry before
  // main.ts builds /docs-json. A lifecycle hook (`onModuleInit`) runs too late.
  constructor(@Inject(OPENAPI_REGISTRY) openApi: OpenApiRegistry) {
    openApi.registerSchema('CreateSkillDto', CreateSkillSchema);
    openApi.registerSchema('UpdateSkillDto', UpdateSkillSchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    openApi.registerSchema('SkillOutputDto', SkillOutputSchema);
  }
}
