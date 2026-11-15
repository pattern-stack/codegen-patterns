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
const _writes = !!_useCase('create');
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
import { Inject, Module,<% if (junctionFanOut.length > 0 || repositoryDepModules.length > 0 || _eav || eavValueTable) { %> forwardRef,<% } %> type OnModuleInit } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '<%= openApiImport %>';
import { DatabaseModule } from '@shared/database/database.module';
<%_ /* ADR-002: the home module of each composed entity (belongs_to + has_many targets, deduped) exports its repository */ _%>
<%_ repositoryDepModules.forEach(dep => { _%>
import { <%= dep.moduleClass %> } from '<%= dep.importPath %>';
<%_ }) _%>
<%_ /* JUNC-0 — the module of each junction this entity is mirrored onto */ _%>
<%_ junctionFanOut.forEach(fan => { _%>
import { <%= fan.junction.moduleClass %> } from '<%= fan.junctionModuleImport %>';
<%_ }) _%>
<% if (_eav) { -%>
import { <%= eavFieldValueModulePascal %>Module } from '<%= eavFieldValueImportDir %>/<%= eavFieldValuePluralStem %>.module';
<% } -%>
<% if (eavValueTable) { -%>
import { <%= eavDefinitionPluralPascal %>Module } from '<%= eavDefinitionImportDir %>/<%= eavDefinitionEntityPluralStem %>.module';
<% } -%>

import { <%= classNames.repository %> } from './<%= entityFileStem %>.repository';
import { <%= classNames.service %> } from './<%= entityFileStem %>.service';
<% if (_api) { -%>
import { <%= classNames.controller %> } from './<%= entityFileStem %>.controller';
<% } -%>
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { <%= classNames.createSchema %> } from './dto/create-<%= entityFileStem %>.dto';
import { <%= classNames.updateSchema %> } from './dto/update-<%= entityFileStem %>.dto';
import { <%= classNames.outputSchema %> } from './dto/<%= entityFileStem %>-output.dto';
import { <%= classNames.findByIdUseCase %> } from './use-cases/find-<%= entityFileStem %>-by-id.use-case';
import { <%= classNames.listUseCase %> } from './use-cases/list-<%= entityPluralFileStem %>.use-case';
<% if (_eav) { -%>
import { <%= classNames.findByIdWithFieldsUseCase %> } from './use-cases/find-<%= entityFileStem %>-by-id-with-fields.use-case';
import { <%= classNames.listWithFieldsUseCase %> } from './use-cases/list-<%= entityPluralFileStem %>-with-fields.use-case';
<% } -%>
<% if (_writes) { -%>
import { <%= classNames.createUseCase %> } from './use-cases/create-<%= entityFileStem %>.use-case';
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
<%_ repositoryDepModules.forEach(dep => { _%>
<%_ if (dep.inherits) { _%>
    // A <%= entityName %> is a kind of <%= dep.entity %>: its repository injects the base's, which that module exports.
<%_ } _%>
    forwardRef(() => <%= dep.moduleClass %>),
<%_ }) _%>
<%_ /* JUNC-0 — forwardRef breaks the parent ↔ junction module cycle (the junction module imports this one for its repository) */ _%>
<%_ junctionFanOut.forEach(fan => { _%>
    forwardRef(() => <%= fan.junction.moduleClass %>),
<%_ }) _%>
<% if (_eav) { -%>
    forwardRef(() => <%= eavFieldValueModulePascal %>Module),
<% } -%>
<% if (eavValueTable) { -%>
    forwardRef(() => <%= eavDefinitionPluralPascal %>Module),
<% } -%>
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
  ],
  controllers: [<% if (_api) { %><%= classNames.controller %><% if (_searchRoute) { %>, <%= classNames.searchController %><% } %><% } %>],
  providers: [
    <%= classNames.repository %>,
    <%= classNames.service %>,
    <%= classNames.findByIdUseCase %>,
    <%= classNames.listUseCase %>,
<% if (_eav) { -%>
    <%= classNames.findByIdWithFieldsUseCase %>,
    <%= classNames.listWithFieldsUseCase %>,
<% } -%>
<% if (_writes) { -%>
    <%= classNames.createUseCase %>,
    <%= classNames.updateUseCase %>,
    <%= classNames.deleteUseCase %>,
<% } -%>
<% if (hasDeclarativeQueries) { -%>
    ...declarativeQueryClasses,
<% } -%>
<% if (_searchUseCase) { -%>
    <%= searchQuery.useCaseClassName %>,
<% } -%>
  ],
  // ADR-002 (revised): the service is the public API; the repository is ALSO
  // exported so sibling modules that compose this entity cross-module (junction
  // `.list()`, EAV value→definition resolution) inject the home-module instance
  // — the only place the repo's own deps are wired (e.g. an EAV entity's repo
  // injects FieldValueService for the #374 integration dual-write tx). Local-providing
  // such a repo elsewhere can't satisfy those deps. Use-case internals stay unexported.
  exports: [<%= classNames.service %>, <%= classNames.repository %>],
})
export class <%= classNames.module %> implements OnModuleInit {
  // OPENAPI-2: register this entity's Zod schemas with the shared
  // OpenApiRegistry at module init. OPENAPI-4 awaits `build()` at boot
  // to emit the full /docs-json document.
  constructor(
    @Inject(OPENAPI_REGISTRY) private readonly openApi: OpenApiRegistry,
  ) {}

  onModuleInit(): void {
    this.openApi.registerSchema('<%= classNames.createDto %>', <%= classNames.createSchema %>);
    this.openApi.registerSchema('<%= classNames.updateDto %>', <%= classNames.updateSchema %>);
    // The response schema is named <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but the generated code publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    this.openApi.registerSchema('<%= classNames.outputDto %>', <%= classNames.outputSchema %>);
  }
}
