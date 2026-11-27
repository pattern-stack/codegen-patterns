
import { z } from 'zod';
import { exampleOf } from '@shared/openapi';
import { CreateToteSchema } from '../../totes/dto/create-tote.dto';

// RFC-0006 §5: the base's schema is the owner of every base field; this child extends it. The kind is fixed
// ('bin') and the tenant column is stamped, so neither is a key here; like any key the schema
// does not declare, one in a body is stripped.
export const CreateBinSchema = CreateToteSchema
  .omit({ kind: true })
  .extend({
    label: z.string(),
    sealed: z.boolean().default(true),
  })
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { ...exampleOf(CreateToteSchema, 'kind'), label: 'Example label', sealed: true } });

export type CreateBinDto = z.infer<typeof CreateBinSchema>;
