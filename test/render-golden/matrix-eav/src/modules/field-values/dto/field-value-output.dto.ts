
import { z } from 'zod';

export const FieldValueOutputSchema = z.object({
  id: z.string().uuid(),
  entityType: z.string(),
  entityId: z.string().uuid(),
  fieldDefinitionId: z.string().uuid(),
  userId: z.string().uuid(),
  value: z.unknown(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

// `Required<…>`: Zod 3 infers a `json` (`z.unknown()`) key as optional; the row
// has it required. Every other key here is required already.
export type FieldValueOutputDto = globalThis.Required<z.infer<typeof FieldValueOutputSchema>>;
