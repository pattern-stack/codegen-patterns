
import { z } from 'zod';
import { ListQuerySchema } from '@shared/http/page';

/**
 * List query DTO for `GET /teams` (pagination-by-default).
 *
 * Re-exports the shared `ListQuerySchema` (page/cursor/pageSize/sort_by/
 * sort_order + `.passthrough()` for arbitrary where-filters). pageSize is
 * clamped (default 50, max 200) and the default sort is `created_at desc, id
 * desc` — both applied in the list use-case via `resolveListQuery`. `cursor` is
 * accepted but v1 ignores it for fetching (offset engine); the keyset seek is a
 * deferred seam.
 */
export const ListTeamsQuerySchema = ListQuerySchema;

export type ListTeamsQueryDto = z.infer<typeof ListTeamsQuerySchema>;
