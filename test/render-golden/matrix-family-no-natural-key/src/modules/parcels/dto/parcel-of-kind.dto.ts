
import { z } from 'zod';
import { ParcelOutputSchema } from './parcel-output.dto';
import { CrateOwnOutputSchema } from '../../crates/dto/crate-output.dto';

/**
 * A parcel read across its kinds (RFC-0006 §3.3, §5): each child's own columns nested under its kind
 * key, a base-only kind bare. It lives in its own file because the children's output schemas extend
 * ParcelOutputSchema — importing them from its file would be a cycle.
 */
export const ParcelOfKindSchema = z.discriminatedUnion('kind', [
  ParcelOutputSchema.extend({ kind: z.literal('crate'), crate: CrateOwnOutputSchema }),
  ParcelOutputSchema.extend({ kind: z.literal('loose') }),
]);

export type ParcelOfKindDto = z.infer<typeof ParcelOfKindSchema>;
