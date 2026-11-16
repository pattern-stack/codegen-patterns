# Demo: Studio's API view on a real project (for the agent pairing with Doug)

You are demoing to Doug the work that just merged into `codegen-patterns` `main` @ `c8da953a` (ADR-046 Phase A,
PRs #876–#887): Studio now shows, per entity, the API the generator emits (repository / service / use cases /
routes) with the YAML line that caused each method; clicking a relationship line lists what that relationship
generates on both sides; and the canvas lays parents above children with one line per relationship (#778).
Goal: let Doug use it on his own project for ~10 minutes and capture his feedback. Do not change code in
`codegen-patterns` — feedback becomes fix-forward issues.

## 0. Preconditions (check, don't assume)

- The codegen checkout is `/Users/dug/Projects/dug/codegen-patterns`, on `main` at `c8da953a` or later
  (`git -C /Users/dug/Projects/dug/codegen-patterns log --oneline -1`). Deps are installed.
- Doug's project has a `codegen.config.yaml` and its entity YAMLs. Call its absolute path `$P`.
- **`$P` is clean in git** (`git -C $P status --short` empty) — or Doug has said it's fine. Studio writes YAML on
  Save, and the Generate button runs `entity new --all --force` in `$P`, which rewrites generated files.
- Ports 5178 and 5179 are free: `lsof -nP -iTCP:5178 -iTCP:5179 -sTCP:LISTEN` prints nothing. If something is
  there, find out what before stopping it — it may be another session's Studio.
- Sanity-check the derivation on `$P` first:
  `bun /Users/dug/Projects/dug/codegen-patterns/src/cli/index.ts project surface --cwd $P`
  It prints a table per entity, plus any warnings. If it fails, that is itself a demo item (step 6) — note the error.

## 1. Start Studio

Run it as a named Herdr terminal (Doug's convention), not a background shell job:

```sh
hc run --bg --no-notify --name studio --cwd /Users/dug/Projects/dug/codegen-patterns -- just studio "$P"
hc wait studio --output "Studio listening"
```

Open **http://127.0.0.1:5178**. Stop it afterwards: `hc kill studio; hc rm studio`.

## 2. The script (walk Doug through, let him drive)

1. **Canvas.** Parents on the top row, children below; each `belongs_to` + inverse `has_many` is **one** line
   labelled `child_rel ⇄ parent_rel`. Two FKs onto one table stay two lines.
2. **API tab.** Click an entity → **API** tab. Sections: Repository, Service, Use cases, HTTP. Each row: signature,
   kind chip, and an origin chip — `base`, `← relationships.<name>`, `← queries[n]`. Inherited methods are one
   collapsed "Inherited from pattern …" group. Look for a **shadow** ("shadows ← queries[0] — resolved to the same
   name and lost") on any entity that declares both a `belongs_to` and a `queries: by: [<fk>]`.
3. **Chip → YAML.** Click any origin chip: the YAML tab opens at that exact line.
4. **Click a line.** The panel lists what that relationship generates on each side, then its inverse, then the
   `?include=` keys.
5. **Junction / `relationship:` nodes** show "not modelled yet (#679)" — deliberate, not empty.
6. **Terminal view.** `codegen project surface` (above) prints the same data; `--entity <name>` for one.
   Warnings flag generated code that would not compile (F7: a `has_many` whose target has no matching
   `belongs_to`; an `eav_value_table` without the Metadata pattern).
7. **Optional — the error state.** Temporarily give one entity a bogus `api.includes` path, reload: the API tab
   shows the CLI's own error with Retry, and the canvas stays. Revert the edit.

## 3. Known limits — say them up front

- Labels of lines between the same two rows can share one horizontal bar until a line is selected (filing as a
  follow-up).
- No parameter/return *types* in the API tab yet (names, kinds and provenance only — slice 2).
- Junction and `relationship:` modules not modelled (#679). No record browsing / running queries (#717).
- Templates still compute the names themselves; Phase B (in progress) switches them to print from this
  derivation. A gate holds the two equal meanwhile, so what the tab shows is what `entity new` emits.
- Future, filed: `queries: by: <relationship>` lifting the target's exportable lookups (#883).

## 4. Capture feedback

Write Doug's reactions as a short list (what confused him, what he wanted to see, anything wrong vs. his
generated code — with entity + method names). Then send it, with the path to your notes, via `SendMessage` to
**`codegen-patterns-7f`** (the lead session for this work). Keep host-application specifics out of anything that
will go on the public `codegen-patterns` tracker — the lead files issues, generically.
