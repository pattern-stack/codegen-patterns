---
to: "<%= outputPaths.module %>"
force: true
---
import { Module } from '@nestjs/common';
import { DatabaseModule } from '@shared/database/database.module';

import { <%= classNames.repository %> } from './<%= name %>.repository';
import { <%= classNames.service %> } from './<%= name %>.service';
import { <%= classNames.controller %> } from './<%= name %>.controller';
import { <%= classNames.findByIdUseCase %> } from './use-cases/find-<%= name %>-by-id.use-case';
import { <%= classNames.listUseCase %> } from './use-cases/list-<%= entityNamePlural %>.use-case';
<% if (hasDeclarativeQueries) { -%>
import { declarativeQueryClasses } from './use-cases/declarative-queries';
<% } -%>

@Module({
  imports: [
    DatabaseModule,
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, etc.)
  ],
  controllers: [<%= classNames.controller %>],
  providers: [
    <%= classNames.repository %>,
    <%= classNames.service %>,
    <%= classNames.findByIdUseCase %>,
    <%= classNames.listUseCase %>,
<% if (hasDeclarativeQueries) { -%>
    ...declarativeQueryClasses,
<% } -%>
    // TODO: Register hand-written use cases here
  ],
  exports: [<%= classNames.service %>],  // Only service is exported (ADR-002)
})
export class <%= classNames.module %> {}
