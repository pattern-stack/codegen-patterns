
import { z } from 'zod';
import { CreateParcelSchema } from './create-parcel.dto';

export const UpdateParcelSchema = CreateParcelSchema.partial();

export type UpdateParcelDto = z.infer<typeof UpdateParcelSchema>;
