
import { z } from 'zod';

export const LeadOutputSchema = z.object({
  id: z.guid(),
  name: z.string(),
  // external_id_tracking behavior — external_id is the public cross-entity join
  // key (a referenced entity exposes it so consumers can join), so it rides the
  // output DTO read-only. provider / provider_metadata stay internal.
  externalId: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
  // The response sample in the API docs (src/derived/examples/).
  .meta({ example: { id: '00000000-0000-4000-8000-000000000001', name: 'Example name', externalId: null, createdAt: '2026-01-15T09:30:00.000Z', updatedAt: '2026-01-15T09:30:00.000Z' } });

export type LeadOutputDto = z.infer<typeof LeadOutputSchema>;
