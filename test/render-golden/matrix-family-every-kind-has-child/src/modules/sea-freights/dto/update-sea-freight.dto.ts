
import { z } from 'zod';
import { CreateSeaFreightSchema } from './create-sea-freight.dto';

export const UpdateSeaFreightSchema = CreateSeaFreightSchema.partial();

export type UpdateSeaFreightDto = z.infer<typeof UpdateSeaFreightSchema>;
