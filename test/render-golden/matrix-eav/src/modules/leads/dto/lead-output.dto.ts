
import { z } from 'zod';

export const LeadOutputSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  // external_id_tracking behavior — external_id is the public cross-entity join
  // key (a referenced entity exposes it so consumers can join), so it rides the
  // output DTO read-only. provider / provider_metadata stay internal.
  externalId: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type LeadOutputDto = z.infer<typeof LeadOutputSchema>;
