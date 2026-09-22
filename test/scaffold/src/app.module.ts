import { Global, Module } from '@nestjs/common';
import { OPENAPI_REGISTRY, OpenApiRegistry } from '@shared/openapi';
import { AccountsModule } from '@gen/modules/accounts/accounts.module';
import { OpportunitiesModule } from '@gen/modules/opportunities/opportunities.module';
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
 *
 * REL-2 (#587) mounts two GENERATED modules as-emitted, because the include
 * allowlist is a property of the generated controller and nothing else:
 *
 *   - AccountsModule — `/accounts`, which declares `api.includes` for
 *     `find_by_id` and `list`. Its generated module also provides the sibling
 *     repositories its service injects (CGP-358b), so no hand-wiring is needed.
 *   - OpportunitiesModule — `/opportunities`, which HAS relations in the graph and
 *     declares NO allowlist. It is here to prove the other half of charter I6: a
 *     route with no `api.includes` entry rejects any `?include=` rather than
 *     ignoring it, even for a relation that exists.
 *
 * Both are deliberately UNSCOPED entities. The tenant-scoped graph
 * (region/site/sensor) is emitted `scopeEnforcement: 'strict'` by TEN-1, so a
 * plain read of it over HTTP throws without an ambient requester context — this
 * harness installs no auth boundary, and its leak tests drive `db.query` directly
 * where a context is trivial to establish.
 *
 * Both generated modules register their Zod DTOs with the shared OpenApiRegistry
 * at `onModuleInit`, so the token has to be bound — one line, the same registry
 * a real consumer's `project init` scaffolds.
 */
/**
 * OpenApiModule — mirrors the `@Global()` wrapper `project init` emits.
 *
 * A generated entity module `@Inject(OPENAPI_REGISTRY)` to register its Zod DTOs
 * at `onModuleInit`, and Nest does NOT make an AppModule provider visible inside
 * an imported feature module — so the token has to be broadcast, exactly as the
 * emitted scaffold does it.
 *
 * ONE divergence from the emitted version, and it is deliberate: `useFactory`
 * rather than `useValue`. A consumer app boots once per process, so `useValue`
 * correctly locks the registry to one instance. This suite boots AppModule once
 * per HTTP test FILE in a single bun process, and a shared registry makes the
 * second boot throw `DuplicateSchemaError` — the registry's own (correct) guard
 * against a forked schema table. A factory gives each app instance its own.
 */
@Global()
@Module({
  providers: [{ provide: OPENAPI_REGISTRY, useFactory: () => new OpenApiRegistry() }],
  exports: [OPENAPI_REGISTRY],
})
class OpenApiModule {}

@Module({
  imports: [
    DatabaseModule,
    OpenApiModule,
    ScaffoldContactsModule,
    AccountsModule,
    OpportunitiesModule,
  ],
})
export class AppModule {}
