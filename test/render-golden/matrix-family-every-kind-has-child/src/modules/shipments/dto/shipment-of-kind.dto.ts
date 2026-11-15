
import { z } from 'zod';
import { ShipmentOutputSchema } from './shipment-output.dto';
import { AirFreightOwnOutputSchema } from '../../air-freights/dto/air-freight-output.dto';
import { SeaFreightOwnOutputSchema } from '../../sea-freights/dto/sea-freight-output.dto';

/**
 * A shipment read across its kinds (RFC-0006 §3.3, §5): each child's own columns nested under its kind
 * key, a base-only kind bare. It lives in its own file because the children's output schemas extend
 * ShipmentOutputSchema — importing them from its file would be a cycle.
 */
export const ShipmentOfKindSchema = z.discriminatedUnion('kind', [
  ShipmentOutputSchema.extend({ kind: z.literal('air'), airFreight: AirFreightOwnOutputSchema }),
  ShipmentOutputSchema.extend({ kind: z.literal('sea'), seaFreight: SeaFreightOwnOutputSchema }),
]);

export type ShipmentOfKindDto = z.infer<typeof ShipmentOfKindSchema>;
