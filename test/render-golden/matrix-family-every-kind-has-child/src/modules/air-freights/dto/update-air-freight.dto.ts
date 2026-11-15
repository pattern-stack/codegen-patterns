
import { z } from 'zod';
import { CreateAirFreightSchema } from './create-air-freight.dto';

export const UpdateAirFreightSchema = CreateAirFreightSchema.partial();

export type UpdateAirFreightDto = z.infer<typeof UpdateAirFreightSchema>;
