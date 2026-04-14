/**
 * Icon glyphs with ASCII fallback for non-Unicode / non-TTY environments.
 *
 * Detection mirrors ADR-016: TTY present, TERM != 'dumb', not in CI.
 */

const unicode =
	Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb' && !process.env.CI;

export const icons = {
	success: unicode ? '✓' : '[OK]',
	error: unicode ? '✗' : '[FAIL]',
	warning: unicode ? '⚠' : '[WARN]',
	info: unicode ? '◆' : '[INFO]',
	arrow: unicode ? '→' : '->',
	bullet: unicode ? '▸' : '>',
	check: unicode ? '✓' : '[x]',
	dash: unicode ? '◌' : '[ ]',
} as const;

export type Icons = typeof icons;
