
import { Inject, Module, forwardRef, type OnModuleInit } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';
import { MemberSkillsModule } from '../member-skills/member-skills.module';

import { MemberRepository } from './member.repository';
import { MemberService } from './member.service';
import { MemberController } from './member.controller';
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { CreateMemberSchema } from './dto/create-member.dto';
import { UpdateMemberSchema } from './dto/update-member.dto';
import { MemberOutputSchema } from './dto/member-output.dto';
import { FindMemberByIdUseCase } from './use-cases/find-member-by-id.use-case';
import { ListMembersUseCase } from './use-cases/list-members.use-case';
import { CreateMemberUseCase } from './use-cases/create-member.use-case';
import { UpdateMemberUseCase } from './use-cases/update-member.use-case';
import { DeleteMemberUseCase } from './use-cases/delete-member.use-case';

@Module({
  imports: [
    DatabaseModule,
    forwardRef(() => MemberSkillsModule),
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
  ],
  controllers: [MemberController],
  providers: [
    MemberRepository,
    MemberService,
    FindMemberByIdUseCase,
    ListMembersUseCase,
    CreateMemberUseCase,
    UpdateMemberUseCase,
    DeleteMemberUseCase,
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [MemberService, MemberRepository],
})
export class MembersModule implements OnModuleInit {
  // OPENAPI-2: register this entity's Zod schemas with the shared
  // OpenApiRegistry at module init. OPENAPI-4 awaits `build()` at boot
  // to emit the full /docs-json document.
  constructor(
    @Inject(OPENAPI_REGISTRY) private readonly openApi: OpenApiRegistry,
  ) {}

  onModuleInit(): void {
    this.openApi.registerSchema('CreateMemberDto', CreateMemberSchema);
    this.openApi.registerSchema('UpdateMemberDto', UpdateMemberSchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    this.openApi.registerSchema('MemberOutputDto', MemberOutputSchema);
  }
}
