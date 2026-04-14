/**
 * Semantic color tokens for the CLI.
 *
 * Commands reference tokens by role (`theme.success`, `theme.muted`), not literal
 * hex codes. A future dark/light toggle becomes a one-file change.
 *
 * See ADR-016 for rationale and palette choices.
 */

import chalk from 'chalk';

export const theme = {
	success: chalk.hex('#A8D8A8'),
	error: chalk.hex('#FF8A80'),
	warning: chalk.hex('#FFD580'),
	system: chalk.hex('#A0D8EF'),
	agent: chalk.hex('#C4A7FF'),
	user: chalk.hex('#D4A5C9'),
	muted: chalk.hex('#888888'),
	dim: chalk.dim,
} as const;

export type Theme = typeof theme;
