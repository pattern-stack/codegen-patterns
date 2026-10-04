/**
 * Theme resolution — the browser half: the `data-theme` attribute, the
 * stored preference, and the system media query.
 *
 * The attribute on `<html>` is the single source of truth. The toggle writes
 * it; `useResolvedTheme` reads it. Anything else that sets it — devtools, a
 * test harness — is honoured the same way CSS honours it.
 */
import { useCallback, useSyncExternalStore } from 'react';
import {
  THEME_STORAGE_KEY,
  parsePreference,
  resolveTheme,
  themeAttribute,
} from './theme';
import type { ResolvedTheme, ThemePreference } from './theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function root(): HTMLElement {
  return document.documentElement;
}

function readPreference(): ThemePreference {
  return parsePreference(root().getAttribute('data-theme'));
}

function systemPrefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

/** Storage can be absent or throw (private windows, blocked site data). */
function loadStored(): ThemePreference {
  try {
    return parsePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

function store(preference: ThemePreference): void {
  try {
    if (preference === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Remembering is a convenience; the choice still applies to this page.
  }
}

function apply(preference: ThemePreference): void {
  const value = themeAttribute(preference);
  if (value == null) root().removeAttribute('data-theme');
  else root().setAttribute('data-theme', value);
}

/**
 * Called once from `main.tsx`, before the first render, so a remembered
 * choice is on `<html>` before anything paints against it.
 */
export function applyStoredTheme(): void {
  apply(loadStored());
}

/** Fires on either input changing: the attribute, or the system preference. */
function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener('change', onChange);
  const observer = new MutationObserver(onChange);
  observer.observe(root(), { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    media.removeEventListener('change', onChange);
    observer.disconnect();
  };
}

/** The theme CSS is currently painting — for the few consumers that need it in script. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, () => resolveTheme(readPreference(), systemPrefersDark()));
}

/** The preference and its setter, for the header toggle. */
export function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  const preference = useSyncExternalStore(subscribe, readPreference);
  const set = useCallback((next: ThemePreference) => {
    store(next);
    apply(next);
  }, []);
  return [preference, set];
}
