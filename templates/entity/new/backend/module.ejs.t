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
import { Inject, Module<% if (junctionFanOut.length > 0 || repositoryDepModules.length > 0 || _eav || eavValueTable) { %>, forwardRef<% } %> } from '@nestjs/common';
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
<% if (_create) { -%>
    <%= classNames.createUseCase %>,
<% } -%>
<% if (_writes) { -%>
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
