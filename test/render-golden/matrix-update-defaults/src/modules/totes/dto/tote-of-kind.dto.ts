
import { z } from 'zod';
import { ToteOutputSchema } from './tote-output.dto';
import { BinOwnOutputSchema } from '../../bins/dto/bin-output.dto';

/**
 * A tote read across its kinds (RFC-0006 §3.3, §5): each child's own columns nested under its kind
 * key, a base-only kind bare. It lives in its own file because the children's output schemas extend
 * ToteOutputSchema — importing them from its file would be a cycle.
 */
export const ToteOfKindSchema = z.discriminatedUnion('kind', [
  ToteOutputSchema.extend({ kind: z.literal('bin'), bin: BinOwnOutputSchema }),
  ToteOutputSchema.extend({ kind: z.literal('loose') }),
]);

export type ToteOfKindDto = z.infer<typeof ToteOfKindSchema>;
