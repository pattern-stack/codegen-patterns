
import { z } from 'zod';
import { exampleOf } from '@shared/openapi';
import { CreateParcelSchema } from '../../parcels/dto/create-parcel.dto';

// RFC-0006 §5: the base's schema is the owner of every base field; this child extends it. The kind is fixed
// ('crate') and the tenant column is stamped, so neither is a key here; like any key the schema
// does not declare, one in a body is stripped.
export const CreateCrateSchema = CreateParcelSchema
  .omit({ kind: true })
  .extend({
    label: z.string(),
  })
  // What Swagger's "Try it out" prefills (src/derived/examples/).
  .meta({ example: { ...exampleOf(CreateParcelSchema, 'kind'), label: 'Example label' } });

export type CreateCrateDto = z.infer<typeof CreateCrateSchema>;
