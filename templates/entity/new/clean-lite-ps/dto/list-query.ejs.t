---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.listQueryDto : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
import { z } from 'zod';
import { ListQuerySchema } from '<%= typeof paginationImport !== 'undefined' ? paginationImport : '@shared/http/pagination' %>';

/**
 * List query DTO for `GET /<%= entityNamePlural %>` (pagination-by-default).
 *
 * Re-exports the shared `ListQuerySchema` (page/cursor/pageSize/sort_by/
 * sort_order + `.passthrough()` for arbitrary where-filters). pageSize is
 * clamped (default 50, max 200) and the default sort is `created_at desc, id
 * desc` — both applied in the list use-case via `resolveListQuery`. `cursor` is
 * accepted but v1 ignores it for fetching (offset engine); the keyset seek is a
 * deferred seam.
 */
export const <%= classNames.listQuerySchema %> = ListQuerySchema;

export type <%= classNames.listQueryDto %> = z.infer<typeof <%= classNames.listQuerySchema %>>;
