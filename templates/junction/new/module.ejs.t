---
to: "<%= outputPaths.module %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
import { Module, forwardRef } from '@nestjs/common';
import { DatabaseModule } from '@shared/database/database.module';

import { <%= classNames.repository %> } from './<%= name %>.repository';
import { <%= classNames.service %> } from './<%= name %>.service';
import { <%= leftModuleClass %> } from '<%= leftModuleImportFromJunction %>';
import { <%= rightModuleClass %> } from '<%= rightModuleImportFromJunction %>';

// Note: No controller — junctions are not directly addressable HTTP resources
// in v1 (Q1 resolution). They are accessed via the canonical port of one of
// the two parent entities. Add a controller in a follow-up if a consumer
// surfaces a need for direct HTTP access to junction rows.

@Module({
  imports: [
    DatabaseModule,
    // CGP-60 — parent modules provide the left/right repositories that the
    // junction service injects for the canonical `list` composition path.
    // forwardRef resolves the parent↔junction module cycle (parent modules
    // also import this module to wire fan-out).
    forwardRef(() => <%= leftModuleClass %>),
    forwardRef(() => <%= rightModuleClass %>),
    // TODO: Add subsystem modules as needed (EventsSubsystemModule, etc.)
  ],
  controllers: [],
  providers: [
    <%= classNames.repository %>,
    <%= classNames.service %>,
    // TODO: Register hand-written use cases here
  ],
  exports: [<%= classNames.service %>],  // Only service is exported (ADR-002)
})
export class <%= classNames.module %> {}
