
import { z } from 'zod';
import { CreateLeadSchema } from './create-lead.dto';

export const UpdateLeadSchema = CreateLeadSchema.partial()
  // A minimal PATCH is what Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { name: 'Example name' } });

export type UpdateLeadDto = z.infer<typeof UpdateLeadSchema>;
