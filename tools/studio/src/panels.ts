/**
 * Which of Studio's two side panels are showing (STUDIO-4) — the pure half.
 *
 * The inspector (right) and the drawer (bottom) each collapse on their own.
 * Full-screen canvas hides both at once and remembers what each was, so
 * invoking it again puts back exactly that. Any other change to either panel —
 * toggling one, or a run opening the drawer — ends full-screen and forgets the
 * remembered state: restoring it later would undo a choice the reader made
 * since.
 */

export interface PanelState {
  inspectorOpen: boolean;
  drawerOpen: boolean;
  /** Set only while full-screen: what each panel was before it began. */
  restore: { inspectorOpen: boolean; drawerOpen: boolean } | null;
}

export type PanelAction =
  | { type: 'toggle-inspector' }
  | { type: 'toggle-drawer' }
  | { type: 'open-drawer' }
  | { type: 'toggle-fullscreen' };

export function initialPanels(inspectorOpen: boolean): PanelState {
  return { inspectorOpen, drawerOpen: true, restore: null };
}

export function isFullscreen(state: PanelState): boolean {
  return state.restore != null;
}

/**
 * The inspector's open/closed state as the reader chose it — what is
 * remembered across reloads. Full-screen is not a choice about the inspector
 * and is not remembered, so while it is on, the answer is what full-screen
 * will restore.
 */
export function rememberedInspectorOpen(state: PanelState): boolean {
  return state.restore?.inspectorOpen ?? state.inspectorOpen;
}

export function panelsReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case 'toggle-inspector':
      return { ...state, inspectorOpen: !state.inspectorOpen, restore: null };
    case 'toggle-drawer':
      return { ...state, drawerOpen: !state.drawerOpen, restore: null };
    case 'open-drawer':
      return { ...state, drawerOpen: true, restore: null };
    case 'toggle-fullscreen':
      if (state.restore != null) return { ...state.restore, restore: null };
      return {
        inspectorOpen: false,
        drawerOpen: false,
        restore: { inspectorOpen: state.inspectorOpen, drawerOpen: state.drawerOpen },
      };
  }
}

// ── Shortcuts ────────────────────────────────────────────────────────────────

/** The parts of a `KeyboardEvent` the decision reads — so it tests without a DOM. */
export interface ShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: ShortcutTarget | null;
}

/** The parts of an event target the typing guard reads (an `Element` satisfies it). */
export interface ShortcutTarget {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

export const INSPECTOR_SHORTCUT = ']';
export const FULLSCREEN_SHORTCUT = '\\';

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * True when a key press is text entry: the target is a form control, or a
 * `contenteditable` element or inside one (CodeMirror's `.cm-content` is one).
 * There `]` and `\` are ordinary characters and must reach the editor.
 */
export function isTypingTarget(target: ShortcutTarget | null): boolean {
  if (target == null) return false;
  if (target.tagName != null && TYPING_TAGS.has(target.tagName.toUpperCase())) return true;
  if (target.isContentEditable === true) return true;
  return target.closest?.('[contenteditable]:not([contenteditable="false"])') != null;
}

/** The panel action a key press asks for, or `null` to leave the key alone. */
export function shortcutAction(event: ShortcutEvent): PanelAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (isTypingTarget(event.target)) return null;
  if (event.key === INSPECTOR_SHORTCUT) return { type: 'toggle-inspector' };
  if (event.key === FULLSCREEN_SHORTCUT) return { type: 'toggle-fullscreen' };
  return null;
}

// ── Remembered inspector state ───────────────────────────────────────────────

/** Per viewer, per browser. The drawer and full-screen are not remembered. */
export const INSPECTOR_STORAGE_KEY = 'studio.inspector';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** Open unless the viewer last closed it; storage absent, throwing or garbled reads as open. */
export function loadInspectorOpen(storage: () => StorageLike | undefined): boolean {
  try {
    return storage()?.getItem(INSPECTOR_STORAGE_KEY) !== 'closed';
  } catch {
    return true;
  }
}

export function storeInspectorOpen(storage: () => StorageLike | undefined, open: boolean): void {
  try {
    storage()?.setItem(INSPECTOR_STORAGE_KEY, open ? 'open' : 'closed');
  } catch {
    // Remembering is a convenience; the panel still toggles on this page.
  }
}
