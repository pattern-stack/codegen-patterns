
import { z } from 'zod';

export const CreateTeamSchema = z.object({
  leadContactId: z.guid().meta({ description: 'The id of an existing contact (GET /contacts lists them). The example is a placeholder: replace it with a real id before sending.' }),
  name: z.string(),
})
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { leadContactId: '00000000-0000-4000-8000-000000000001', name: 'Example name' } });

export type CreateTeamDto = z.infer<typeof CreateTeamSchema>;
