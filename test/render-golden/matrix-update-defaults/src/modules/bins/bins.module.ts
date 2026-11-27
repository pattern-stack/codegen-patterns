
import { Inject, Module, forwardRef } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';
import { TotesModule } from '../totes/totes.module';

import { BinRepository } from './bin.repository';
import { BinService } from './bin.service';
import { BinController } from './bin.controller';
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { CreateBinSchema } from './dto/create-bin.dto';
import { UpdateBinSchema } from './dto/update-bin.dto';
import { BinOutputSchema } from './dto/bin-output.dto';
import { FindBinByIdUseCase } from './use-cases/find-bin-by-id.use-case';
import { ListBinsUseCase } from './use-cases/list-bins.use-case';
import { CreateBinUseCase } from './use-cases/create-bin.use-case';
import { UpdateBinUseCase } from './use-cases/update-bin.use-case';
import { DeleteBinUseCase } from './use-cases/delete-bin.use-case';

@Module({
  imports: [
    DatabaseModule,
    // A bin is a kind of tote: its repository injects the base's, which that module exports.
    forwardRef(() => TotesModule),
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
  ],
  controllers: [BinController],
  providers: [
    BinRepository,
    BinService,
    FindBinByIdUseCase,
    ListBinsUseCase,
    CreateBinUseCase,
    UpdateBinUseCase,
    DeleteBinUseCase,
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [BinService, BinRepository],
})
export class BinsModule {
  // OPENAPI-2: register this entity's Zod schemas when Nest constructs the
  // module (in `NestFactory.create`), so they are in the registry before
  // main.ts builds /docs-json. A lifecycle hook (`onModuleInit`) runs too late.
  constructor(@Inject(OPENAPI_REGISTRY) openApi: OpenApiRegistry) {
    openApi.registerSchema('CreateBinDto', CreateBinSchema);
    openApi.registerSchema('UpdateBinDto', UpdateBinSchema);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    openApi.registerSchema('BinOutputDto', BinOutputSchema);
  }
}
