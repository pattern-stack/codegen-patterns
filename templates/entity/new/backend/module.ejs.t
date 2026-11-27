---
to: "<%= outputPaths.module %>"
force: true
---
<%- generatedBanner %>
<%_
// ADR-046 — what this module wires is read from the derivation
// (`src/derived/api/`): whether HTTP is on, and which use cases and routes
// exist. The provider list itself is slice 3.
const _useCase = (kind) => apiSurface.useCases.find((u) => u.kind === kind);
const _api = apiSurface.http.enabled;
const _eav = !!_useCase('find_by_id_with_fields');
// A base whose every kind has a child table has no create (RFC-0006 §4.1) but keeps update / delete: two use cases, two reads.
const _create = !!_useCase('create');
const _writes = !!_useCase('update');
// The create DTO is registered unless the derivation removed the base's create (a `writes: false` entity still registers it).
const _createDto = !apiSurface.createDisabledBy;
const _searchUseCase = _useCase('search');
const _searchRoute = !!_searchUseCase && apiSurface.http.routes.some((r) => r.useCase === _searchUseCase.className);
_%>
<% if (hasEmits) { -%>
/**
 * EVT-7: This entity emits typed domain events. Use-cases depend on
 * TYPED_EVENT_BUS + DRIZZLE. Ensure EventsModule is registered in the
 * root AppModule (global) so these tokens resolve at runtime.
 */
<% } -%>
import { Inject, Module<% if (wiring.moduleImports.length > 0) { %>, forwardRef<% } %> } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '<%= openApiImport %>';
import { DatabaseModule } from '@shared/database/database.module';
<%_ /* PW-1 — the module of every class this module's classes take (the class graph's `moduleImports`): the base's, each
   composed entity's (ADR-002: its home module exports its repository), each fanned-out junction's (JUNC-0), the EAV blocks' */ _%>
<%_ wiring.moduleImports.forEach(dep => { _%>
import { <%= dep.moduleClass %> } from '<%= dep.importPath %>';
<%_ }) _%>

import { <%= classNames.repository %> } from './<%= entityFileStem %>.repository';
import { <%= classNames.service %> } from './<%= entityFileStem %>.service';
<% if (_api) { -%>
import { <%= classNames.controller %> } from './<%= entityFileStem %>.controller';
<% } -%>
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
<% if (_createDto) { -%>
import { <%= classNames.createSchema %> } from './dto/create-<%= entityFileStem %>.dto';
<% } -%>
import { <%= classNames.updateSchema %> } from './dto/update-<%= entityFileStem %>.dto';
import { <%= classNames.outputSchema %> } from './dto/<%= entityFileStem %>-output.dto';
import { <%= classNames.findByIdUseCase %> } from './use-cases/find-<%= entityFileStem %>-by-id.use-case';
import { <%= classNames.listUseCase %> } from './use-cases/list-<%= entityPluralFileStem %>.use-case';
<% if (_eav) { -%>
import { <%= classNames.findByIdWithFieldsUseCase %> } from './use-cases/find-<%= entityFileStem %>-by-id-with-fields.use-case';
import { <%= classNames.listWithFieldsUseCase %> } from './use-cases/list-<%= entityPluralFileStem %>-with-fields.use-case';
<% } -%>
<% if (_create) { -%>
import { <%= classNames.createUseCase %> } from './use-cases/create-<%= entityFileStem %>.use-case';
<% } -%>
<% if (_writes) { -%>
import { <%= classNames.updateUseCase %> } from './use-cases/update-<%= entityFileStem %>.use-case';
import { <%= classNames.deleteUseCase %> } from './use-cases/delete-<%= entityFileStem %>.use-case';
<% } -%>
<% if (hasDeclarativeQueries) { -%>
import { declarativeQueryClasses } from './use-cases/declarative-queries';
<% } -%>
<% if (_searchUseCase) { -%>
import { <%= searchQuery.useCaseClassName %> } from './use-cases/search-<%= entityPluralFileStem %>.use-case';
<% if (_searchRoute) { -%>
import { <%= classNames.searchController %> } from './<%= entityFileStem %>-search.controller';
<% } -%>
<% } -%>

@Module({
  imports: [
    DatabaseModule,
<%_ /* forwardRef: Nest's module graph has cycles the class graph doesn't (a junction's module imports this one for its repository) */ _%>
<%_ wiring.moduleImports.forEach(dep => { _%>
<%_ if (dep.reason === 'inherits') { _%>
    // A <%= entityName %> is a kind of <%= dep.owner %>: its repository injects the base's, which that module exports.
<%_ } _%>
    forwardRef(() => <%= dep.moduleClass %>),
<%_ }) _%>
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
  ],
  controllers: [<%= wiring.controllers.join(', ') %>],
  providers: [
<%_ /* PW-1 — every class the graph lists for this entity, in its order; the declarative queries print as their one spread */ _%>
<%_ wiring.providers.forEach((p, i) => { _%>
<%_ if (p.useCaseKind === 'query') { _%>
<%_ if (wiring.providers[i - 1]?.useCaseKind !== 'query') { _%>
    ...declarativeQueryClasses,
<%_ } _%>
<%_ } else { _%>
    <%= p.id %>,
<%_ } _%>
<%_ }) _%>
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [<%= classNames.service %>, <%= classNames.repository %>],
})
export class <%= classNames.module %> {
  // OPENAPI-2: register this entity's Zod schemas when Nest constructs the
  // module (in `NestFactory.create`), so they are in the registry before
  // main.ts builds /docs-json. A lifecycle hook (`onModuleInit`) runs too late.
  constructor(@Inject(OPENAPI_REGISTRY) openApi: OpenApiRegistry) {
<% if (_createDto) { -%>
    openApi.registerSchema('<%= classNames.createDto %>', <%= classNames.createSchema %>);
<% } -%>
    openApi.registerSchema('<%= classNames.updateDto %>', <%= classNames.updateSchema %>);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    openApi.registerSchema('<%= classNames.outputDto %>', <%= classNames.outputSchema %>);
  }
}
