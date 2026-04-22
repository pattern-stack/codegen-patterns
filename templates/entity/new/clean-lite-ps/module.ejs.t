---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.module : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' %>"
force: true
---
<% if (hasEmits) { -%>
/**
 * EVT-7: This entity emits typed domain events. Use-cases depend on
 * TYPED_EVENT_BUS + DRIZZLE. Ensure EventsModule is registered in the
 * root AppModule (global) so these tokens resolve at runtime.
 */
<% } -%>
import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { OPENAPI_REGISTRY, type OpenApiRegistry } from '@shared/openapi';
import { DatabaseModule } from '@shared/database/database.module';
<%_ clpBelongsTo.forEach(rel => { _%>
// import { <%= rel.relatedEntityPascal %>sModule } from '../<%= rel.relatedPlural %>/<%= rel.relatedPlural %>.module';
<%_ }) _%>
<% if (eavEnabled) { -%>
import { FieldValuesModule } from '../field_values/field_values.module';
<% } -%>
<% if (eavValueTable) { -%>
import { <%= eavDefinitionPluralPascal %>Module } from '../<%= eavDefinitionEntityPlural %>/<%= eavDefinitionEntityPlural %>.module';
<% } -%>

import { <%= classNames.repository %> } from './<%= entityName %>.repository';
import { <%= classNames.service %> } from './<%= entityName %>.service';
import { <%= classNames.controller %> } from './<%= entityName %>.controller';
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
import { <%= classNames.searchController %> } from './<%= entityName %>-search.controller';
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
  controllers: [<%= classNames.controller %><% if (hasSearchQuery) { %>, <%= classNames.searchController %><% } %>],
  providers: [
    <%= classNames.repository %>,
    <%= classNames.service %>,
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
  exports: [<%= classNames.service %>],  // Only service is exported (ADR-002)
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
