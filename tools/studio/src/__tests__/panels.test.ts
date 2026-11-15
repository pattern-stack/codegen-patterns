/**
 * The side panels (STUDIO-4): full-screen hides both and gives back exactly
 * what was there; any single-panel change ends it; the shortcuts never fire
 * while the reader is typing; the remembered inspector state survives broken
 * storage.
 */
import { describe, expect, test } from 'bun:test';

import {
  INSPECTOR_STORAGE_KEY,
  initialPanels,
  isFullscreen,
  loadInspectorOpen,
  panelsReducer,
  rememberedInspectorOpen,
  shortcutAction,
  storeInspectorOpen,
} from '../panels';
import type { PanelState, ShortcutEvent, ShortcutTarget } from '../panels';

const START: readonly PanelState[] = [
  { inspectorOpen: true, drawerOpen: true, restore: null },
  { inspectorOpen: true, drawerOpen: false, restore: null },
  { inspectorOpen: false, drawerOpen: true, restore: null },
  { inspectorOpen: false, drawerOpen: false, restore: null },
];

const fullscreen = (s: PanelState) => panelsReducer(s, { type: 'toggle-fullscreen' });

describe('full-screen', () => {
  for (const start of START) {
    const name = `inspector ${start.inspectorOpen ? 'open' : 'closed'}, drawer ${start.drawerOpen ? 'open' : 'closed'}`;

    test(`hides both panels from ${name}`, () => {
      const on = fullscreen(start);
      expect(on.inspectorOpen).toBe(false);
      expect(on.drawerOpen).toBe(false);
      expect(isFullscreen(on)).toBe(true);
    });

    test(`round-trips to exactly ${name}`, () => {
      expect(fullscreen(fullscreen(start))).toEqual(start);
    });
  }

  test('toggling the inspector ends full-screen, and nothing stale is restored later', () => {
    const on = fullscreen(START[0]!);
    const shown = panelsReducer(on, { type: 'toggle-inspector' });
    expect(shown).toEqual({ inspectorOpen: true, drawerOpen: false, restore: null });
    expect(isFullscreen(shown)).toBe(false);
    // A second full-screen remembers the new state, not the first one's.
    expect(fullscreen(fullscreen(shown))).toEqual(shown);
  });

  test('toggling the drawer ends full-screen', () => {
    const shown = panelsReducer(fullscreen(START[0]!), { type: 'toggle-drawer' });
    expect(shown).toEqual({ inspectorOpen: false, drawerOpen: true, restore: null });
  });

  test('a run opening the drawer ends full-screen', () => {
    const shown = panelsReducer(fullscreen(START[0]!), { type: 'open-drawer' });
    expect(shown).toEqual({ inspectorOpen: false, drawerOpen: true, restore: null });
  });
});

describe('single panels', () => {
  test('each toggle flips only its own panel', () => {
    const s = initialPanels(true);
    expect(panelsReducer(s, { type: 'toggle-inspector' })).toEqual({ inspectorOpen: false, drawerOpen: true, restore: null });
    expect(panelsReducer(s, { type: 'toggle-drawer' })).toEqual({ inspectorOpen: true, drawerOpen: false, restore: null });
  });

  test('the drawer starts open; the inspector starts as remembered', () => {
    expect(initialPanels(false)).toEqual({ inspectorOpen: false, drawerOpen: true, restore: null });
  });
});

describe('rememberedInspectorOpen — full-screen is not remembered', () => {
  test('full-screen from an open inspector still remembers it open', () => {
    const on = fullscreen(START[0]!);
    expect(on.inspectorOpen).toBe(false);
    expect(rememberedInspectorOpen(on)).toBe(true);
  });

  test('full-screen from a closed inspector remembers it closed', () => {
    expect(rememberedInspectorOpen(fullscreen(START[2]!))).toBe(false);
  });

  test('toggling the inspector — on its own or out of full-screen — is remembered', () => {
    for (const start of START) {
      const toggled = panelsReducer(start, { type: 'toggle-inspector' });
      expect(rememberedInspectorOpen(toggled)).toBe(!start.inspectorOpen);
    }
    expect(rememberedInspectorOpen(panelsReducer(fullscreen(START[0]!), { type: 'toggle-inspector' }))).toBe(true);
  });

  test('entering and exiting full-screen leaves it unchanged', () => {
    for (const start of START) {
      const before = rememberedInspectorOpen(start);
      expect(rememberedInspectorOpen(fullscreen(start))).toBe(before);
      expect(rememberedInspectorOpen(fullscreen(fullscreen(start)))).toBe(before);
    }
  });

  test('the drawer has no say in it', () => {
    for (const action of [{ type: 'toggle-drawer' }, { type: 'open-drawer' }] as const) {
      expect(rememberedInspectorOpen(panelsReducer(START[0]!, action))).toBe(true);
      expect(rememberedInspectorOpen(panelsReducer(START[3]!, action))).toBe(false);
    }
  });
});

// ── Shortcuts ────────────────────────────────────────────────────────────────

const element = (tagName: string, opts: { editable?: boolean; insideEditable?: boolean } = {}): ShortcutTarget => ({
  tagName,
  isContentEditable: opts.editable ?? false,
  closest: (selector: string) => (opts.insideEditable === true && selector.includes('contenteditable') ? {} : null),
});

const press = (key: string, target: ShortcutTarget | null = element('DIV'), mods: Partial<ShortcutEvent> = {}): ShortcutEvent => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  target,
  ...mods,
});

describe('shortcutAction', () => {
  test('] toggles the inspector, \\ toggles full-screen', () => {
    expect(shortcutAction(press(']'))).toEqual({ type: 'toggle-inspector' });
    expect(shortcutAction(press('\\'))).toEqual({ type: 'toggle-fullscreen' });
    expect(shortcutAction(press(']', null))).toEqual({ type: 'toggle-inspector' });
  });

  test('other keys are left alone', () => {
    for (const key of ['[', 'a', 'Escape', '}', '|']) expect(shortcutAction(press(key))).toBeNull();
  });

  test('typing targets swallow both keys', () => {
    const targets: Record<string, ShortcutTarget> = {
      input: element('INPUT'),
      textarea: element('TEXTAREA'),
      select: element('SELECT'),
      'lower-case tag': element('textarea'),
      contenteditable: element('DIV', { editable: true }),
      'inside a contenteditable (CodeMirror .cm-line)': element('SPAN', { insideEditable: true }),
    };
    for (const [name, target] of Object.entries(targets)) {
      for (const key of [']', '\\']) {
        expect({ name, key, action: shortcutAction(press(key, target)) }).toEqual({ name, key, action: null });
      }
    }
  });

  test('a held modifier swallows both keys', () => {
    for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      for (const key of [']', '\\']) {
        expect({ mod, key, action: shortcutAction(press(key, element('DIV'), { [mod]: true })) }).toEqual({
          mod,
          key,
          action: null,
        });
      }
    }
  });
});

// ── Storage ──────────────────────────────────────────────────────────────────

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

const throwing = {
  getItem: (): string | null => {
    throw new Error('blocked');
  },
  setItem: (): void => {
    throw new Error('blocked');
  },
};

describe('remembered inspector state', () => {
  test('round-trips through storage', () => {
    const s = memoryStorage();
    storeInspectorOpen(() => s, false);
    expect(s.data.get(INSPECTOR_STORAGE_KEY)).toBe('closed');
    expect(loadInspectorOpen(() => s)).toBe(false);
    storeInspectorOpen(() => s, true);
    expect(loadInspectorOpen(() => s)).toBe(true);
  });

  test('falls back to open when storage is empty, garbled, absent or throwing', () => {
    expect(loadInspectorOpen(() => memoryStorage())).toBe(true);
    expect(loadInspectorOpen(() => memoryStorage({ [INSPECTOR_STORAGE_KEY]: '{"x":1' }))).toBe(true);
    expect(loadInspectorOpen(() => undefined)).toBe(true);
    expect(loadInspectorOpen(() => throwing)).toBe(true);
    expect(
      loadInspectorOpen(() => {
        throw new Error('no localStorage');
      }),
    ).toBe(true);
  });

  test('a throwing store is swallowed', () => {
    expect(() => storeInspectorOpen(() => throwing, false)).not.toThrow();
  });
});
