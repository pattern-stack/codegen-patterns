
import { z } from 'zod';

export const CreateCategorySchema = z.object({
  parentCategoryId: z.guid().meta({ description: 'The id of an existing category (GET /categories lists them). The example is a placeholder: replace it with a real id before sending.' }),
  name: z.string(),
})
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { parentCategoryId: '00000000-0000-4000-8000-000000000001', name: 'Example name' } });

export type CreateCategoryDto = z.infer<typeof CreateCategorySchema>;
