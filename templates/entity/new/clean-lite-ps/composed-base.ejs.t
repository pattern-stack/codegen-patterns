---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.composedBase : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' || !clpOutputPaths.composedBase %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
<%_ /* ADR-041 §6 — emitted only when TWO OR MORE capabilities stack. One
      capability is wrapped inline in the repository's own `extends` clause;
      a three-deep inline clause is what this file exists to avoid. */ _%>
import { <%= repositoryBaseClass %> } from '<%= repositoryBaseImport %>';
<%_ capabilityMixins.forEach((cap) => { _%>
import { <%= cap.mixin %> } from '<%= cap.importPath %>';
<%_ }) _%>
import { <%= entityNamePlural %>, type <%= classNames.entity %> } from './<%= entityName %>.entity';
<%_ if (typeof hasIntegrationSurface !== 'undefined' && hasIntegrationSurface) { _%>
<%_ /* Type-only, and therefore erased: the repository module imports this file
      back for its `extends` clause. A value import here would be a real cycle;
      an `import type` is not. */ _%>
import type {
  <%= classNames.entity %>IntegrationWrite,
  <%= classNames.entity %>IntegrationProjection,
} from './<%= entityName %>.repository';
<%_ } _%>

/**
 * Composed repository base for <%= classNames.entity %> — the `<%= patternName %>` spine with
 * <%= capabilityMixins.length %> capabilities layered over it (ADR-041).
 *
 * Nesting follows declaration order in the entity's `patterns:` list, rightmost
 * outermost:
<%_ capabilityMixins.forEach((cap) => { _%>
 *   - <%= cap.name %> (<%= cap.mixin %>)
<%_ }) _%>
 *
 * Abstract members of the spine stay abstract here and are implemented by the
 * concrete <%= classNames.repository %>.
 */
export abstract class <%= composedBaseClass %> extends <%- composedBaseExtendsClause %> {}
