---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.service : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' %>"
force: true
---
import { Injectable } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/base-analytics-service';
import { <%= serviceBaseClass %> } from '<%= serviceBaseImport %>';
import { <%= classNames.repository %> } from './<%= entityName %>.repository';
import type { <%= classNames.entity %> } from './<%= entityName %>.entity';

@Injectable()
export class <%= classNames.service %> extends WithAnalytics(
  <%= serviceBaseClass %><<%= classNames.repository %>, <%= classNames.entity %>>,
) {
  constructor(protected readonly repository: <%= classNames.repository %>) {
    super();
  }

  // TODO: Add entity-specific domain methods here.
  // Services contain pure data operations only (ADR-003).
  // Do NOT emit events, enqueue jobs, or call external systems from service methods.
  //
  // Inherited from <%= serviceBaseClass %>:
<%_ serviceInheritedMethods.forEach(line => { _%>
  //   <%= line %>
<%_ }) _%>
}
