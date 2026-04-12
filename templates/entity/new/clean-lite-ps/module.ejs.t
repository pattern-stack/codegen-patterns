---
to: <%= clpOutputPaths.module %>
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
    // TODO: Register hand-written use cases here
  ],
  exports: [<%= classNames.service %>],  // Only service is exported (ADR-002)
})
export class <%= classNames.module %> {}
