
import { z } from 'zod';
import { exampleOf } from '@shared/openapi';
import { ToteOutputSchema } from '../../totes/dto/tote-output.dto';

// RFC-0006 §5: the columns THIS table owns, alone. `ToteOfKindSchema` nests it under the kind key.
export const BinOwnOutputSchema = z.object({
  id: z.guid(),
  label: z.string(),
  sealed: z.boolean().nullable(),
})
  // The response sample in the API docs (src/derived/examples/).
  .meta({ example: { id: '00000000-0000-4000-8000-000000000001', label: 'Example label', sealed: true } });

// The flat shape every HTTP read and write of a bin returns: the base's output with the kind fixed, and
// this table's columns at the same level.
export const BinOutputSchema = ToteOutputSchema.extend({
  kind: z.literal('bin'),
  ...BinOwnOutputSchema.omit({ id: true }).shape,
}).meta({ example: { ...exampleOf(ToteOutputSchema), kind: 'bin', ...exampleOf(BinOwnOutputSchema, 'id') } });

export type BinOutputDto = z.infer<typeof BinOutputSchema>;
