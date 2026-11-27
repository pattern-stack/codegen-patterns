
import { z } from 'zod';

export const SkillOutputSchema = z.object({
  id: z.guid(),
  label: z.string(),
})
  // The response sample in the API docs (src/derived/examples/).
  .meta({ example: { id: '00000000-0000-4000-8000-000000000001', label: 'Example label' } });

export type SkillOutputDto = z.infer<typeof SkillOutputSchema>;
