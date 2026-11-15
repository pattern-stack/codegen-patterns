---
to: "<%= outputPaths.updateDto %>"
force: true
---
<%- generatedBanner %>
import { z } from 'zod';
import { <%= classNames.createSchema %> } from './create-<%= entityFileStem %>.dto';

<% if (familyBase) { -%>
// RFC-0006 §4.1: a row does not change kind, so the update takes no `<%= familyBase.discriminatorProp %>`; one in a body is stripped.
export const <%= classNames.updateSchema %> = <%= classNames.createSchema %>.omit({ <%= familyBase.discriminatorProp %>: true }).partial();
<% } else { -%>
export const <%= classNames.updateSchema %> = <%= classNames.createSchema %>.partial();
<% } -%>

export type <%= classNames.updateDto %> = z.infer<typeof <%= classNames.updateSchema %>>;
