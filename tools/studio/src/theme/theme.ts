/**
 * Theme resolution — the pure half.
 *
 * Studio has two palettes and one switch. The switch is CSS's own
 * `color-scheme`: every colour token is written once as `light-dark(light,
 * dark)` (see `index.css`), and the browser picks a side per element from the
 * `color-scheme` it inherits. `:root` declares `light dark`, so with no
 * attribute the system preference decides; `data-theme="light" | "dark"` on
 * `<html>` narrows it to one side, in either direction.
 *
 * So the attribute *is* the preference: absent means `system`. Nothing here
 * stores a resolved theme anywhere — the few places that need it in script
 * (CodeMirror's dark flag) derive it with `resolveTheme`, from the same two
 * inputs CSS uses.
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/** Toggle order, and the only values `parsePreference` accepts. */
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

/** Where the explicit choice is remembered, per browser. */
export const THEME_STORAGE_KEY = 'studio.theme';

/**
 * Anything that is not a known preference — a missing key, an empty
 * attribute, a value written by an older build — means "follow the system".
 */
export function parsePreference(raw: unknown): ThemePreference {
  return typeof raw === 'string' && (THEME_PREFERENCES as readonly string[]).includes(raw)
    ? (raw as ThemePreference)
    : 'system';
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

/** The `data-theme` value a preference puts on `<html>`, or `null` to remove it. */
export function themeAttribute(preference: ThemePreference): ResolvedTheme | null {
  return preference === 'system' ? null : preference;
}

/** One colour, both themes — the shape every themed table in Studio uses. */
export interface ThemedColor {
  light: string;
  dark: string;
}

/**
 * A `ThemedColor` as a CSS value the browser resolves itself. Usable anywhere
 * a colour is — inline styles, SVG `style`, CodeMirror's generated rules — so
 * a table keeps both values side by side and no renderer branches on a theme.
 */
export function cssColor({ light, dark }: ThemedColor): string {
  return `light-dark(${light}, ${dark})`;
}
