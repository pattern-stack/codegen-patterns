
import { z } from 'zod';
import { CreateShipmentSchema } from './create-shipment.dto';

// RFC-0006 §4.1: a row does not change kind, so the update takes no `kind`; one in a body is stripped.
export const UpdateShipmentSchema = CreateShipmentSchema.omit({ kind: true }).partial();

export type UpdateShipmentDto = z.infer<typeof UpdateShipmentSchema>;
