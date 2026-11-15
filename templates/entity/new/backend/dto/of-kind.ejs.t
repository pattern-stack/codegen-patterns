---
to: "<%= outputPaths.ofKindDto %>"
skip_if: "<%= !outputPaths.ofKindDto %>"
force: true
---
<%- generatedBanner %>
<% if (familyBase && outputPaths.ofKindDto) { -%>
import { z } from 'zod';
import { <%= classNames.outputSchema %> } from './<%= entityFileStem %>-output.dto';
<% familyBase.children.forEach((c) => { -%>
import { <%= c.ownOutputSchema %> } from '<%= c.outputImportPath %>';
<% }) -%>

/**
 * A <%= entityName %> read across its kinds (RFC-0006 §3.3, §5): each child's own columns nested under its kind
 * key, a base-only kind bare. It lives in its own file because the children's output schemas extend
 * <%= classNames.outputSchema %> — importing them from its file would be a cycle.
 */
export const <%= classNames.ofKindSchema %> = z.discriminatedUnion('<%= familyBase.discriminatorProp %>', [
<% familyBase.kinds.forEach((k) => { const c = familyBase.children.find((x) => x.as === k); -%>
<% if (c) { -%>
  <%= classNames.outputSchema %>.extend({ <%= familyBase.discriminatorProp %>: z.literal('<%= k %>'), <%= c.relKey %>: <%= c.ownOutputSchema %> }),
<% } else { -%>
  <%= classNames.outputSchema %>.extend({ <%= familyBase.discriminatorProp %>: z.literal('<%= k %>') }),
<% } -%>
<% }) -%>
]);

export type <%= classNames.ofKindDto %> = z.infer<typeof <%= classNames.ofKindSchema %>>;
<% } -%>
