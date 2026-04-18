---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.module : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' %>"
force: true
---
import { Module } from '@nestjs/common';
import { DatabaseModule } from '@shared/database/database.module';
<%_ clpBelongsTo.forEach(rel => { _%>
// import { <%= rel.relatedEntityPascal %>sModule } from '../<%= rel.relatedPlural %>/<%= rel.relatedPlural %>.module';
<%_ }) _%>

import { <%= classNames.repository %> } from './<%= entityName %>.repository';
import { <%= classNames.service %> } from './<%= entityName %>.service';
import { <%= classNames.controller %> } from './<%= entityName %>.controller';
import { <%= classNames.findByIdUseCase %> } from './use-cases/find-<%= entityName %>-by-id.use-case';
import { <%= classNames.listUseCase %> } from './use-cases/list-<%= entityNamePlural %>.use-case';
<% if (generateWrites) { -%>
import { <%= classNames.createUseCase %> } from './use-cases/create-<%= entityName %>.use-case';
import { <%= classNames.updateUseCase %> } from './use-cases/update-<%= entityName %>.use-case';
import { <%= classNames.deleteUseCase %> } from './use-cases/delete-<%= entityName %>.use-case';
<% } -%>
<% if (hasDeclarativeQueries) { -%>
import { declarativeQueryClasses } from './use-cases/declarative-queries';
<% } -%>

@Module({
  imports: [
    DatabaseModule,
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, IntegrationsSubsystemModule, etc.)
    // Cross-domain modules from relationships:
<%_ clpBelongsTo.forEach(rel => { _%>
    // <%= rel.relatedEntityPascal %>sModule,
<%_ }) _%>
  ],
  controllers: [<%= classNames.controller %>],
  providers: [
    <%= classNames.repository %>,
    <%= classNames.service %>,
    <%= classNames.findByIdUseCase %>,
    <%= classNames.listUseCase %>,
<% if (generateWrites) { -%>
    <%= classNames.createUseCase %>,
    <%= classNames.updateUseCase %>,
    <%= classNames.deleteUseCase %>,
<% } -%>
<% if (hasDeclarativeQueries) { -%>
    ...declarativeQueryClasses,
<% } -%>
  ],
  exports: [<%= classNames.service %>],  // Only service is exported (ADR-002)
})
export class <%= classNames.module %> {}
