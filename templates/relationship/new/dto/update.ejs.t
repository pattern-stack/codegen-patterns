---
to: "<%= outputPaths.updateDto %>"
force: true
---
import { z } from 'zod';
import { <%= classNames.createSchema %> } from './create-<%= name %>.dto';

export const <%= classNames.updateSchema %> = <%= classNames.createSchema %>.partial();

export type <%= classNames.updateDto %> = z.infer<typeof <%= classNames.updateSchema %>>;
