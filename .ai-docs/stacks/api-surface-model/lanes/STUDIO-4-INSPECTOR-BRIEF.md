# Lane brief — STUDIO-4 (part 2): the Inspector can be hidden

You are a **build lane for one change**, folded into the STUDIO-4 PR (not yet pushed) so the owner signs off once.
The owner asked for it on 2026-11-14: hide the right-hand Inspector for full-screen ERD exploration.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-studio-4-tree-blocks`, branch
  `dugshub/studio-4-tree-blocks` @ `c55d9d2b` (STUDIO-4 part 1, committed: the trees wrap into viewport-fitting rows,
  the legend sits bottom-right, the minimap top-right). Work on top of it, uncommitted. Deps are installed; if a gate
  says otherwise, `mise trust && just install`.
- **Lead (me):** session `dugshub-api-surface-a0-1e`, hc terminal `t1t9`. Report with `SendMessage` to that name. If it
  does not resolve, `ListAgents` (name starts `dugshub-api-surface-a0-`) and check with `hc get t1t9`.

## Today

`tools/studio/src/App.tsx` keeps `inspectorWidth` (drag-resizable, min 320) and renders `<Inspector>` in a fixed-basis
column; there is no way to hide it. The bottom `Drawer` already toggles (`drawerOpen`, its own `Hide ▾` / `Show ▴`
button in its header bar, which stays visible when collapsed) — mirror that. `generate()` opens the drawer.

## What the owner asked for (do not widen it)

1. **A visible collapse/expand toggle for the Inspector, plus a keyboard shortcut.** Collapsed means the canvas takes
   the full width (a thin rail holding the expand control is fine; mirror the drawer's collapsed bar). Shortcut: `]`
   toggles the Inspector. **The shortcut must never fire while the user is typing** — the Inspector holds a CodeMirror
   YAML editor and form inputs, where `]` is an ordinary character: ignore the key when the event target is an
   `input`, `textarea`, `select`, a `contenteditable` element or inside one (CodeMirror's `.cm-content` is
   contenteditable), and when Ctrl / Meta / Alt is held. Put the toggle's shortcut in its `title` / `aria-label`.
2. **One "full-screen canvas" action** that hides Inspector + drawer together and is reversible: invoking it again
   restores exactly the open/closed state each had before. Shortcut `\` (same typing guard). Toggling either panel on
   its own while full-screen, or `generate()` opening the drawer, simply ends full-screen (no stale restore later).
3. **Selecting while collapsed — decided: show it's hidden; do not reopen.** Rationale (put it in a code comment):
   clicking cards to light their neighbours *is* the exploration; reopening would shrink the canvas and refit it on
   every click. So when the Inspector is collapsed and something is selected, the collapsed rail/toggle says so — the
   selected entity's or line's name and that the Inspector is hidden, with the expand control right there. Nothing is
   selected → the rail shows only the expand control.
4. **Refit after a toggle.** After any Inspector / drawer / full-screen toggle, the canvas fits to view at its *new*
   size. Fit once the canvas has actually been re-measured (its `ResizeObserver` in `graph/SchemaCanvas.tsx` already
   sees the new box) — not on a guessed timer, and not to the old size. A drag-resize of the Inspector keeps today's
   behaviour (refit only when the packing re-wraps); only toggles force the fit. Thread whatever signal you need
   through `graph/GraphPane.tsx`.
5. **Remember the Inspector's open/closed state per viewer** in `localStorage` (key `studio.inspector`), every read and
   write in `try/catch`, the same way `theme/use-theme.ts` does; it must render correctly with storage absent or
   throwing. The drawer and full-screen are not persisted.

**Never unmount the Inspector when hiding it.** It holds unsaved YAML (`onDirtyChange` / the `beforeunload` guard);
collapsing must keep it mounted (e.g. hidden with `display: none`) so an unsaved edit survives hide → show. Test or
state how you checked this.

**Tokens only** — no colour literals anywhere you touch (`tools/studio/src/index.css` tokens, `var(--…)`); spacing from
the `--sp-*` scale.

## A seam to test

Put the panel state in a small pure reducer (e.g. `tools/studio/src/panels.ts`: state `{ inspectorOpen, drawerOpen,
restore }`, actions toggle-inspector / toggle-drawer / open-drawer / toggle-fullscreen) and the shortcut decision in a
pure function (`(event-like) → action | null`, including the typing guard), and unit-test both in
`tools/studio/src/__tests__/` — full-screen round-trips to the exact prior state from each of the four starting
combinations; a single-panel toggle or open-drawer ends full-screen; the guard rejects each typing target and each
modifier; the storage load falls back to open when storage throws or holds garbage.

## Rules (binding)

- **No sub-agents. No commit, push, PR, merge or `gh stack`.** Leave your work uncommitted; the lead commits.
- **Public repo — private-context rule.** This repo is public. Never put host-application names, paths, table names or
  "dogfood" references into code, comments, tests, fixtures or docs; say "a host application". Fixtures use generic
  names of your own.
- **Scope:** code in `tools/studio/src/**` only. Docs: a short paragraph where `docs/specs/STUDIO-0.md` describes the
  Studio UI, and the controls list in `.ai-docs/studio/README.md` if it has one. Nothing under `src/**`,
  `templates/**`, any `package.json`, any snapshot or golden. Don't revert or rework STUDIO-4 part 1.
- Never weaken anything existing: no `.skip`/`.todo`/`.only`, no type escapes. Any pre-existing assertion you change
  must be listed in your report with a one-line reason (none is expected).
- **Stop and report instead of inventing** on any design question this brief does not answer. Two failed attempts at
  the same gate is also a stop.

## Exit — run all of this on your final tree, after your last edit

1. `just test-studio` → 0 (UI typecheck, UI unit run ` 0 fail`, e2e). The UI test total is part 1's (197) plus yours.
2. `git diff -- tools/studio/src | grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\('` → no output (no colour literals).
3. `git diff -- tools/studio/src/__tests__ | grep -n '^-.*expect('` → no output.
4. **Mutation:** make full-screen not restore (e.g. always reopen both) → a reducer test goes red. Make the guard accept
   typing in a `textarea` → a guard test goes red. Revert each; `git status --porcelain` back to what it was.
5. Run the app (`just studio-demo` or the Studio dev server on the demo) and click through: toggle with the button and
   with `]`; type `]` into the YAML editor and confirm the Inspector stays open and the character is typed; select a
   node while collapsed and see the rail name it; full-screen with `\` and back; reload and see the Inspector state
   remembered; make an unsaved YAML edit, hide, show, and see it still there. Report what you saw — the lead captures
   the owner's screenshots.

## Report (SendMessage to `dugshub-api-surface-a0-1e`)

Short: files; each exit step → exit code → the deciding line; the mutations' red lines; the exact controls (labels,
shortcuts, where the toggle and rail sit) so the lead can script screenshots; anything you could not do. Then stop and
wait.
