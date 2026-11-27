
import { z } from 'zod';

export const CreateShelfSchema = z.object({
  label: z.string(),
  active: z.boolean().default(true),
  archived: z.boolean().default(false),
})
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { label: 'Example label', active: true, archived: false } });

export type CreateShelfDto = z.infer<typeof CreateShelfSchema>;
