---
to: <%= clpOutputPaths.repository %>
force: true
---
import { Injectable, Inject } from '@nestjs/common';
import { DRIZZLE } from '@shared/constants/tokens';
import type { DrizzleClient } from '@shared/types/drizzle';
import { <%= repositoryBaseClass %> } from '<%= repositoryBaseImport %>';
import { <%= entityNamePlural %>, type <%= classNames.entity %> } from './<%= entityName %>.entity';

@Injectable()
export class <%= classNames.repository %> extends <%= repositoryBaseClass %><<%= classNames.entity %>> {
  readonly table = <%= entityNamePlural %>;

  constructor(@Inject(DRIZZLE) db: DrizzleClient) {
    super(db);
  }

  // TODO: Add entity-specific query methods here.
  // Inherited from <%= repositoryBaseClass %>:
<%_ repositoryInheritedMethods.forEach(line => { _%>
  //   <%= line %>
<%_ }) _%>
}
