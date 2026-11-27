
import { z } from 'zod';
import { ListQuerySchema } from '@shared/http/page';

/**
 * List query DTO for `GET /audit_entries` (pagination-by-default).
 *
 * Re-exports the shared `ListQuerySchema` (page/cursor/pageSize/sort_by/
 * sort_order; a `z.looseObject`, so arbitrary where-filters pass through). pageSize is
 * clamped (default 50, max 200) and the default sort is `created_at desc, id
 * desc` — both applied in the list use-case via `resolveListQuery`. `cursor` is
 * accepted but v1 ignores it for fetching (offset engine); the keyset seek is a
 * deferred seam.
 */
export const ListAuditEntriesQuerySchema = ListQuerySchema;

export type ListAuditEntriesQueryDto = z.infer<typeof ListAuditEntriesQuerySchema>;
