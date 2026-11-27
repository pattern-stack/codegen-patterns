---
to: "<%= outputPaths.wiring %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
<%_ if (typeof patternStackWiring !== 'undefined' && patternStackWiring) { _%>
/**
 * <%= classNames.entity %>'s pattern-stack wiring (PW-3c): how the junction's classes are constructed, with no DI container.
 *
 * Its repository is built with the other repositories; its service takes both ends' repositories, and both ends'
 * services take it (the fan-out). The module that holds both ends (`module.ts`) calls these in that order.
 */
import type { DrizzleClient } from '<%= drizzleTypeImport %>';
import type { Relations } from '<%= relationsImport %>';
import { <%= classNames.repository %> } from './<%= entityFileStem %>.repository';
import { <%= classNames.service %> } from './<%= entityFileStem %>.service';
import type { <%= leftRepositoryClass %> } from '<%= leftRepoImportFromJunction %>';
<%_ if (rightRepositoryClass !== leftRepositoryClass) { _%>
import type { <%= rightRepositoryClass %> } from '<%= rightRepoImportFromJunction %>';
<%_ } _%>

/** Builds <%= classNames.entity %>'s repository. */
export function create<%= classNames.repository %>(db: DrizzleClient<Relations>): <%= classNames.repository %> {
  return new <%= classNames.repository %>(db);
}

/** Builds <%= classNames.entity %>'s service over its repository and both ends' repositories. */
export function create<%= classNames.service %>(deps: {
  repository: <%= classNames.repository %>;
  left: <%= leftRepositoryClass %>;
  right: <%= rightRepositoryClass %>;
}): <%= classNames.service %> {
  return new <%= classNames.service %>(deps.repository, deps.left, deps.right);
}
<%_ } _%>
