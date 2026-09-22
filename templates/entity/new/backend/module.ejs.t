---
to: "<%= outputPaths.module %>"
force: true
---
<%- generatedBanner %>
<% if (hasEmits) { -%>
/**
 * EVT-7: This entity emits typed domain events. Use-cases depend on
 * TYPED_EVENT_BUS + DRIZZLE. Ensure EventsModule is registered in the
 * root AppModule (global) so these tokens resolve at runtime.
 */
<% } -%>
import { Inject, Module,<% if (junctionFanOut.length > 0) { %> forwardRef,<% } %> type OnModuleInit } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '<%= openApiImport %>';
import { DatabaseModule } from '@shared/database/database.module';
<%_ /* #632: one import per composed repository (belongs_to + has_many targets, deduped) */ _%>
<%_ repositoryDeps.forEach(dep => { _%>
import { <%= dep.repositoryClass %> } from '<%= dep.importDir %>/<%= dep.fileStem %>.repository';
<%_ }) _%>
<%_ /* JUNC-0 — the module of each junction this entity is mirrored onto */ _%>
<%_ junctionFanOut.forEach(fan => { _%>
import { <%= fan.junction.moduleClass %> } from '<%= fan.junctionModuleImport %>';
<%_ }) _%>
<% if (eavEnabled) { -%>
import { <%= eavFieldValueModulePascal %>Module } from '<%= eavFieldValueImportDir %>/<%= eavFieldValuePluralStem %>.module';
<% } -%>
<% if (eavValueTable) { -%>
import { <%= eavDefinitionPluralPascal %>Module } from '<%= eavDefinitionImportDir %>/<%= eavDefinitionEntityPluralStem %>.module';
<% } -%>

import { <%= classNames.repository %> } from './<%= entityFileStem %>.repository';
import { <%= classNames.service %> } from './<%= entityFileStem %>.service';
<% if (apiEnabled) { -%>
import { <%= classNames.controller %> } from './<%= entityFileStem %>.controller';
<% } -%>
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { <%= classNames.createSchema %> } from './dto/create-<%= entityFileStem %>.dto';
import { <%= classNames.updateSchema %> } from './dto/update-<%= entityFileStem %>.dto';
import { <%= classNames.outputSchema %> } from './dto/<%= entityFileStem %>-output.dto';
import { <%= classNames.findByIdUseCase %> } from './use-cases/find-<%= entityFileStem %>-by-id.use-case';
import { <%= classNames.listUseCase %> } from './use-cases/list-<%= entityPluralFileStem %>.use-case';
<% if (eavEnabled) { -%>
import { <%= classNames.findByIdWithFieldsUseCase %> } from './use-cases/find-<%= entityFileStem %>-by-id-with-fields.use-case';
import { <%= classNames.listWithFieldsUseCase %> } from './use-cases/list-<%= entityPluralFileStem %>-with-fields.use-case';
<% } -%>
<% if (generateWrites) { -%>
import { <%= classNames.createUseCase %> } from './use-cases/create-<%= entityFileStem %>.use-case';
import { <%= classNames.updateUseCase %> } from './use-cases/update-<%= entityFileStem %>.use-case';
import { <%= classNames.deleteUseCase %> } from './use-cases/delete-<%= entityFileStem %>.use-case';
<% } -%>
<% if (hasDeclarativeQueries) { -%>
import { declarativeQueryClasses } from './use-cases/declarative-queries';
<% } -%>
<% if (hasSearchQuery) { -%>
import { <%= searchQuery.useCaseClassName %> } from './use-cases/search-<%= entityPluralFileStem %>.use-case';
<% if (apiEnabled) { -%>
import { <%= classNames.searchController %> } from './<%= entityFileStem %>-search.controller';
<% } -%>
<% } -%>

@Module({
  imports: [
    DatabaseModule,
<%_ /* JUNC-0 — forwardRef breaks the parent ↔ junction module cycle (the junction module imports this one for its repository) */ _%>
<%_ junctionFanOut.forEach(fan => { _%>
    forwardRef(() => <%= fan.junction.moduleClass %>),
<%_ }) _%>
<% if (eavEnabled) { -%>
    <%= eavFieldValueModulePascal %>Module,
<% } -%>
<% if (eavValueTable) { -%>
    <%= eavDefinitionPluralPascal %>Module,
<% } -%>
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
    // Cross-domain modules from relationships:
<%_ belongsTo.forEach(rel => { _%>
    // <%= rel.relatedEntityPascal %>sModule,
<%_ }) _%>
  ],
  controllers: [<% if (apiEnabled) { %><%= classNames.controller %><% if (hasSearchQuery) { %>, <%= classNames.searchController %><% } %><% } %>],
  providers: [
    <%= classNames.repository %>,
    <%= classNames.service %>,
<%_ /* CGP-358b / #632: register each composed repository once (needed for service DI) */ _%>
<%_ repositoryDeps.forEach(dep => { _%>
    <%= dep.repositoryClass %>,
<%_ }) _%>
    <%= classNames.findByIdUseCase %>,
    <%= classNames.listUseCase %>,
<% if (eavEnabled) { -%>
    <%= classNames.findByIdWithFieldsUseCase %>,
    <%= classNames.listWithFieldsUseCase %>,
<% } -%>
<% if (generateWrites) { -%>
    <%= classNames.createUseCase %>,
    <%= classNames.updateUseCase %>,
    <%= classNames.deleteUseCase %>,
<% } -%>
<% if (hasDeclarativeQueries) { -%>
    ...declarativeQueryClasses,
<% } -%>
<% if (hasSearchQuery) { -%>
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
