
import { z } from 'zod';
import { CreateToteSchema } from '../../totes/dto/create-tote.dto';

// RFC-0006 §5: the base's schema is the owner of every base field; this child extends it. The kind is fixed
// ('bin') and the tenant column is stamped, so neither is a key here; like any key the schema
// does not declare, one in a body is stripped.
export const CreateBinSchema = CreateToteSchema
  .omit({ kind: true })
  .extend({
    label: z.string(),
    sealed: z.boolean().default(false),
  });

export type CreateBinDto = z.infer<typeof CreateBinSchema>;
