---
to: "<%= outputPaths.updateDto %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
import { z } from 'zod';
import { <%= classNames.createSchema %> } from './create-<%= name %>.dto';

export const <%= classNames.updateSchema %> = <%= classNames.createSchema %>.partial();

export type <%= classNames.updateDto %> = z.infer<typeof <%= classNames.updateSchema %>>;
