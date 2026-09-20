---
to: "<%= outputPaths.updateDto %>"
force: true
---
<%- generatedBanner %>
import { z } from 'zod';
import { <%= classNames.createSchema %> } from './create-<%= entityFileStem %>.dto';

export const <%= classNames.updateSchema %> = <%= classNames.createSchema %>.partial();

export type <%= classNames.updateDto %> = z.infer<typeof <%= classNames.updateSchema %>>;
