---
to: "<%= outputPaths.wiring %>"
force: true
---
<%- generatedBanner %>
<%_ if (patternStackWiringParts) { _%>
/**
 * <%= classNames.entity %>'s pattern-stack wiring (PW-3): how its classes are constructed, with no DI container.
 *
 * Two phases, because entities compose each other's repositories (a `belongs_to` one way, a `has_many` back):
 * every repository is built first, then every service and its use cases. The context's composition
 * (`module.ts` beside this context's folders) calls both, in that order.
 */
import type { DrizzleClient } from '<%= drizzleTypeImport %>';
import type { Relations } from '<%= relationsImport %>';
import type { OpenApiRegistry } from '<%= openApiImport %>';
import { <%= classNames.repository %> } from './<%= entityFileStem %>.repository';
import { <%= classNames.service %> } from './<%= entityFileStem %>.service';
<%_ if (familyChild) { _%>
import type { <%= familyChild.baseRepositoryClass %> } from '<%= familyChild.baseRepositoryImportPath %>';
<%_ } _%>
<%_ repositoryDeps.forEach((dep) => { _%>
<%_ if (!familyChild || dep.repositoryClass !== familyChild.baseRepositoryClass) { _%>
import type { <%= dep.repositoryClass %> } from '<%= dep.importDir %>/<%= dep.fileStem %>.repository';
<%_ } _%>
<%_ }) _%>
<%_ plainWiringParts.junctionServices.forEach((j) => { _%>
import type { <%= j.serviceClass %> } from '<%= j.importPath %>';
<%_ }) _%>
<%_ openApiSchemas.forEach((s) => { _%>
import { <%= s.schemaName %> } from '<%= s.importFile %>';
<%_ }) _%>
<%_ const _queries = patternStackWiringParts.useCases.filter((u) => u.kind === 'query'); _%>
<%_ patternStackWiringParts.useCases.filter((u) => u.kind !== 'query').forEach((u) => { _%>
import { <%= u.className %> } from '<%= u.importPath %>';
<%_ }) _%>
<%_ if (_queries.length > 0) { _%>
import { <%= _queries.map((u) => u.className).join(', ') %> } from '<%= _queries[0].importPath %>';
<%_ } _%>

/**
 * <%= classNames.entity %>'s repository as its context holds it (PW-3b): the class's public members, structurally, so
 * a context's code and its tests can take any object with them. The context's `<Context>Repositories` bundle lists one
 * per entity.
 */
export type <%= patternStackWiringParts.repositoryPort %> = { [K in keyof <%= classNames.repository %>]: <%= classNames.repository %>[K] };

/** Builds <%= classNames.entity %>'s repository<% if (familyChild) { %>; a <%= entityName %> is a kind of <%= familyChild.baseName %>, so it takes the base's<% } %>. */
export function <%= patternStackWiringParts.repositoryFactory %>(
  db: DrizzleClient<Relations>,
<%_ if (familyChild) { _%>
  baseRepository: <%= familyChild.baseRepositoryClass %>,
<%_ } _%>
): <%= classNames.repository %> {
  return new <%= classNames.repository %>(db<% if (familyChild) { %>, baseRepository<% } %>);
}

/**
 * What <%= classNames.entity %>'s service takes: its repository, then each composed entity's (#632)<% if (plainWiringParts.junctionServices.length > 0) { %>, then each
 * junction's service it fans out to (PW-3c)<% } %>.
 */
export interface <%= classNames.entity %>ServiceDeps {
  repository: <%= classNames.repository %>;
<%_ repositoryDeps.forEach((dep) => { _%>
  <%= dep.property %>: <%= dep.repositoryClass %>;
<%_ }) _%>
<%_ plainWiringParts.junctionServices.forEach((j) => { _%>
  <%= j.property %>: <%= j.serviceClass %>;
<%_ }) _%>
}

/** Builds <%= classNames.entity %>'s service and its use cases. */
export function <%= patternStackWiringParts.servicesFactory %>(deps: <%= classNames.entity %>ServiceDeps) {
  const service = new <%= classNames.service %>(deps.repository<% repositoryDeps.forEach((dep) => { %>, deps.<%= dep.property %><% }) %><% plainWiringParts.junctionServices.forEach((j) => { %>, deps.<%= j.property %><% }) %>);
<%_ const _list = plainWiringParts.useCases.find((u) => u.kind === 'list'); _%>
  const <%= _list.key %> = new <%= _list.className %>(service);
  return {
    service,
    useCases: {
<%_ patternStackWiringParts.useCases.forEach((u) => { _%>
<%_ if (u.kind === 'list') { _%>
      <%= u.key %>,
<%_ } else if (u.kind === 'search') { _%>
      <%= u.key %>: new <%= u.className %>(<%= _list.key %>),
<%_ } else { _%>
      <%= u.key %>: new <%= u.className %>(service),
<%_ } _%>
<%_ }) _%>
    },
  };
}

export type <%= classNames.entity %>Services = ReturnType<typeof <%= patternStackWiringParts.servicesFactory %>>;

/** Registers <%= classNames.entity %>'s DTO schemas, as the Nest module's constructor does; `<generated>/openapi.ts` calls every entity's. */
export function <%= patternStackWiringParts.registerSchemas %>(openApi: OpenApiRegistry): void {
<%_ openApiSchemas.forEach((s) => { _%>
  openApi.registerSchema('<%= s.dtoName %>', <%= s.schemaName %>);
<%_ }) _%>
}
<%_ } _%>
