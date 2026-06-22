---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.module : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
<% if (hasEmits) { -%>
/**
 * EVT-7: This entity emits typed domain events. Use-cases depend on
 * TYPED_EVENT_BUS + DRIZZLE. Ensure EventsModule is registered in the
 * root AppModule (global) so these tokens resolve at runtime.
 */
<% } -%>
import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '<%= typeof openApiImport !== 'undefined' ? openApiImport : '@shared/openapi' %>';
import { DatabaseModule } from '@shared/database/database.module';
<%_ /* CGP-358b: Import cross-entity repos needed for has_many composition */ _%>
<%_ if (typeof clpExistingHasMany !== 'undefined') { _%>
<%_ const hasManyNeedingImport = clpExistingHasMany.filter(r => !r.isSelfRef); _%>
<%_ const uniqueHasManyForModule = [...new Map(hasManyNeedingImport.map(r => [r.target, r])).values()]; _%>
<%_ uniqueHasManyForModule.forEach(rel => { _%>
import { <%= rel.targetClass %>Repository } from '../<%= rel.targetPlural %>/<%= rel.target %>.repository';
<%_ }) _%>
<%_ } _%>
<%_ /* CGP-358b: Import cross-entity repos needed for belongs_to composition */ _%>
<%_ if (typeof clpBelongsTo !== 'undefined') { _%>
<%_ const uniqueBelongsToForModule = [...new Map(clpBelongsTo.filter(r => !r.isSelfFk).map(r => [r.relatedEntity, r])).values()]; _%>
<%_ uniqueBelongsToForModule.forEach(rel => { _%>
import { <%= rel.relatedEntityPascal %>Repository } from '../<%= rel.relatedPlural %>/<%= rel.relatedEntity %>.repository';
<%_ }) _%>
<%_ } _%>
<% if (eavEnabled) { -%>
import { FieldValuesModule } from '../field_values/field_values.module';
<% } -%>
<% if (eavValueTable) { -%>
import { <%= eavDefinitionPluralPascal %>Module } from '../<%= eavDefinitionEntityPlural %>/<%= eavDefinitionEntityPlural %>.module';
<% } -%>

import { <%= classNames.repository %> } from './<%= entityName %>.repository';
import { <%= classNames.service %> } from './<%= entityName %>.service';
<% if (clpApiEnabled) { -%>
import { <%= classNames.controller %> } from './<%= entityName %>.controller';
<% } -%>
// OPENAPI-2: Zod schemas registered with OpenApiRegistry at module init.
import { <%= classNames.createSchema %> } from './dto/create-<%= entityName %>.dto';
import { <%= classNames.updateSchema %> } from './dto/update-<%= entityName %>.dto';
import { <%= classNames.outputSchema %> } from './dto/<%= entityName %>-output.dto';
import { <%= classNames.findByIdUseCase %> } from './use-cases/find-<%= entityName %>-by-id.use-case';
import { <%= classNames.listUseCase %> } from './use-cases/list-<%= entityNamePlural %>.use-case';
<% if (eavEnabled) { -%>
import { <%= classNames.findByIdWithFieldsUseCase %> } from './use-cases/find-<%= entityName %>-by-id-with-fields.use-case';
import { <%= classNames.listWithFieldsUseCase %> } from './use-cases/list-<%= entityNamePlural %>-with-fields.use-case';
<% } -%>
<% if (generateWrites) { -%>
import { <%= classNames.createUseCase %> } from './use-cases/create-<%= entityName %>.use-case';
import { <%= classNames.updateUseCase %> } from './use-cases/update-<%= entityName %>.use-case';
import { <%= classNames.deleteUseCase %> } from './use-cases/delete-<%= entityName %>.use-case';
<% } -%>
<% if (hasDeclarativeQueries) { -%>
import { declarativeQueryClasses } from './use-cases/declarative-queries';
<% } -%>
<% if (hasSearchQuery) { -%>
import { <%= searchQuery.useCaseClassName %> } from './use-cases/search-<%= entityNamePlural %>.use-case';
<% if (clpApiEnabled) { -%>
import { <%= classNames.searchController %> } from './<%= entityName %>-search.controller';
<% } -%>
<% } -%>

@Module({
  imports: [
    DatabaseModule,
<% if (eavEnabled) { -%>
    FieldValuesModule,
<% } -%>
<% if (eavValueTable) { -%>
    <%= eavDefinitionPluralPascal %>Module,
<% } -%>
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
    // Cross-domain modules from relationships:
<%_ clpBelongsTo.forEach(rel => { _%>
    // <%= rel.relatedEntityPascal %>sModule,
<%_ }) _%>
  ],
  controllers: [<% if (clpApiEnabled) { %><%= classNames.controller %><% if (hasSearchQuery) { %>, <%= classNames.searchController %><% } %><% } %>],
  providers: [
    <%= classNames.repository %>,
    <%= classNames.service %>,
<%_ /* CGP-358b: Register cross-entity repos as providers (needed for service DI) */ _%>
<%_ if (typeof clpExistingHasMany !== 'undefined') { _%>
<%_ const uniqueHasManyProviders = [...new Map(clpExistingHasMany.filter(r => !r.isSelfRef).map(r => [r.target, r])).values()]; _%>
<%_ uniqueHasManyProviders.forEach(rel => { _%>
    <%= rel.targetClass %>Repository,
<%_ }) _%>
<%_ } _%>
<%_ if (typeof clpBelongsTo !== 'undefined') { _%>
<%_ const uniqueBelongsToProviders = [...new Map(clpBelongsTo.filter(r => !r.isSelfFk).map(r => [r.relatedEntity, r])).values()]; _%>
<%_ uniqueBelongsToProviders.forEach(rel => { _%>
    <%= rel.relatedEntityPascal %>Repository,
<%_ }) _%>
<%_ } _%>
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
    // CLP pipeline names the response schema <Entity>OutputDto (matches
    // classNames.outputDto); the OPENAPI-2 spec sketch uses "ResponseDto"
    // but existing CLP code already publishes OutputDto everywhere, so we
    // keep consistency. OPENAPI-3 decorators reference the same name.
    this.openApi.registerSchema('<%= classNames.outputDto %>', <%= classNames.outputSchema %>);
  }
}
