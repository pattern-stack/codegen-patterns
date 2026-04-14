---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.service : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' %>"
force: true
---
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { <%= serviceBaseClass %> } from '<%= serviceBaseImport %>';
import { <%= classNames.repository %> } from './<%= entityName %>.repository';
import type { <%= classNames.entity %> } from './<%= entityName %>.entity';

@Injectable()
export class <%= classNames.service %> extends WithAnalytics(
  <%= serviceBaseClass %><<%= classNames.repository %>, <%= classNames.entity %>>,
) {
  protected override readonly entityName = '<%= entityName %>';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus?: unknown;

  constructor(protected readonly repository: <%= classNames.repository %>) {
    super(repository);
  }

  // Lifecycle events (created/updated/deleted + per-field changes) are emitted
  // automatically by BaseService when the events subsystem is installed.
  //
  // Inherited from <%= serviceBaseClass %>:
<%_ serviceInheritedMethods.forEach(line => { _%>
  //   <%= line %>
<%_ }) _%>
}
