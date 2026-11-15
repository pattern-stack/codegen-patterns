
import { z } from 'zod';

export const CreateShipmentSchema = z.object({
  kind: z.never(),
  weight: z.number().int(),
});

export type CreateShipmentDto = z.infer<typeof CreateShipmentSchema>;
