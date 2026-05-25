---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.updateDto : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
import { z } from 'zod';
import { <%= classNames.createSchema %> } from './create-<%= entityName %>.dto';

export const <%= classNames.updateSchema %> = <%= classNames.createSchema %>.partial();

export type <%= classNames.updateDto %> = z.infer<typeof <%= classNames.updateSchema %>>;
