
import { z } from 'zod';
import { CreateMemberSchema } from './create-member.dto';

export const UpdateMemberSchema = CreateMemberSchema.partial()
  // A minimal PATCH is what Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { name: 'Example name' } });

export type UpdateMemberDto = z.infer<typeof UpdateMemberSchema>;
