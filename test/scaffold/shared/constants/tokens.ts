/**
 * Shared injection tokens.
 * DRIZZLE must match exactly what generated repositories use in @Inject(DRIZZLE).
 * The generated repository imports this constant from '@shared/constants/tokens'.
 */
export const DRIZZLE = 'DRIZZLE' as const;
export type DrizzleToken = typeof DRIZZLE;
