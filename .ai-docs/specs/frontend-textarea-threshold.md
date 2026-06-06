# Spec: Configurable textarea inference threshold (`frontend.fields.textareaThreshold`)

- **Status:** approved (human-approved in-session, 2026-06-06; no tracker issue — local work)
- **Scope:** frontend emitter UI-type inference (ADR-038 / FE-3, FE-4)
- **Branch:** `feat/frontend-textarea-threshold` — commit locally, **do NOT open a PR**, no tracker writes

## Problem

`inferUiType()` hardcodes the string→textarea threshold at `src/emitters/frontend/field-meta.ts:119`:

```ts
case 'string':
    return field.constraints.maxLength && field.constraints.maxLength > 500
        ? 'textarea'
        : 'text';
```

The `500` was ported verbatim from the deleted `templates/entity/new/prompt.js`. It decides
single-line input vs textarea for every bounded string field across every generated app, and
there is no config surface for it — the `frontend:` block (`codegen-config.schema.ts`) has only
transport/wiring sections (`auth`, `parsers`, `sync`, `catalog`); nothing about field-meta
inference is configurable. The only escape hatch is per-field `ui_type: textarea`.

The plumbing gap: `deriveFieldMeta`/`inferUiType` are pure functions over `ParsedField` and never
see `FrontendEmitContext`. `buildEntityFieldsFile` (emit-fields.ts:214) has `ctx.config` in scope
but drops it before `displayFields` (emit-fields.ts:154).

## Design

### 1. Config schema — new `frontend.fields` section

In `src/schema/codegen-config.schema.ts`, add:

```ts
export const FrontendFieldsConfigSchema = z
  .object({
    textareaThreshold: z.number().int().positive().nullable().default(500),
  })
  .strict()          // unknown key here is a stale-config error, per the FrontendConfigSchema rationale
  .default({});

export type FrontendFieldsConfig = z.infer<typeof FrontendFieldsConfigSchema>;
```

and register it in `FrontendConfigSchema` (which is `.strict()`, so the key must be declared):

```ts
fields: FrontendFieldsConfigSchema,
```

Semantics follow the house **present-but-null disables** convention (same as `auth.function`,
`sync.columnMapper` — Zod `.default()` fires only on `undefined`):

- **absent** → `500` (today's behavior, byte-identical output)
- **explicit number** → custom threshold (strict `>`: `maxLength` must *exceed* it)
- **explicit `null`** → heuristic disabled; bounded strings stay `text` unless `ui_type` says otherwise

Doc-comment the section like its siblings (purpose, defaults, null semantics).

### 2. Emit config — `FrontendEmitConfig` + wiring

- `src/emitters/frontend/types.ts`: add **required** `textareaThreshold: number | null` to
  `FrontendEmitConfig` with a doc comment (`frontend.fields.textareaThreshold — string→textarea
  inference cutoff; null disables. Default 500.`). Required, matching every other key —
  `mapFrontendEmitConfig` always supplies it.
- `src/emitters/frontend/load-context.ts` `mapFrontendEmitConfig()`: add
  `textareaThreshold: fe.fields.textareaThreshold,` to the returned object.
- `src/__tests__/emitters/frontend/_helpers.ts` `config()`: add `textareaThreshold: 500` to the
  default fixture.

### 3. Pure-function threading — `field-meta.ts`

Keep `inferUiType`/`deriveFieldMeta` pure; add an options param:

```ts
/** House default for the string→textarea max_length cutoff. */
export const DEFAULT_TEXTAREA_THRESHOLD = 500;

/** Knobs for the UI-type inference ladder (from frontend.fields config). */
export interface InferenceOptions {
  /** string→textarea cutoff; null disables the heuristic; undefined ⇒ DEFAULT_TEXTAREA_THRESHOLD. */
  textareaThreshold?: number | null;
}

export function inferUiType(field: ParsedField, opts: InferenceOptions = {}): FieldType
export function deriveFieldMeta(field, defaults = {}, opts: InferenceOptions = {}): DerivedFieldMeta
```

The `string` case becomes:

```ts
const threshold = opts.textareaThreshold === undefined
    ? DEFAULT_TEXTAREA_THRESHOLD
    : opts.textareaThreshold;
// ...
case 'string':
    return threshold !== null &&
        field.constraints.maxLength &&
        field.constraints.maxLength > threshold
            ? 'textarea'
            : 'text';
```

Invariants to preserve:
- **Strict `>`** boundary — `maxLength === threshold` ⇒ `text`.
- **Unbounded short-circuit** — `maxLength` undefined ⇒ `text`, regardless of threshold.
- **Ladder order unchanged** — explicit `ui.type` (rung 1) beats the heuristic in every config.
- `deriveFieldMeta` passes `opts` through to `inferUiType`; nothing else in it changes.

Note in the `EAV_DATA_TYPE_TO_FIELD_TYPE` docs is already correct (EAV has no textarea
heuristic — no `max_length`); the knob does not touch the EAV path.

### 4. Call-site threading — `emit-fields.ts`

- `displayFields(parsed, opts: InferenceOptions)` (module-private; only caller is
  `buildEntityFieldsFile`) passes `opts` into `deriveFieldMeta`.
- `buildEntityFieldsFile` calls
  `displayFields(parsed, { textareaThreshold: ctx.config.textareaThreshold })`.

### 5. Public exports

`src/emitters/frontend/index.ts` already re-exports `deriveFieldMeta`/`inferUiType`; add
`InferenceOptions` (type) and `DEFAULT_TEXTAREA_THRESHOLD` alongside.

## Tests (`bun test` via `just test-unit`)

`src/__tests__/emitters/frontend/emit-fields.test.ts`:
1. Defaults unchanged: no opts ⇒ `maxLength: 1000` → `textarea` (existing test stays green);
   `maxLength: 500` → `text` (boundary); `maxLength: 501` → `textarea`; no `max_length` → `text`.
2. Custom threshold: `{ textareaThreshold: 100 }` ⇒ `maxLength: 150` → `textarea`,
   `maxLength: 100` → `text`.
3. Null disables: `{ textareaThreshold: null }` ⇒ `maxLength: 10000` → `text`.
4. Explicit `ui_type` wins over both custom and null configs.
5. Threading proof: `buildEntityFieldsFile` with ctx `textareaThreshold: null` (and a custom
   value) reflects in the emitted `type:` literals — guards against the ctx→displayFields hop
   regressing.

`src/__tests__/emitters/frontend/load-context.test.ts` (`mapFrontendEmitConfig`):
6. Absent `frontend.fields` ⇒ `textareaThreshold: 500`.
7. Explicit `null` survives (no default-stomping).
8. Custom value (e.g. `2000`) passes through.

## Docs (same change, per CLAUDE.md living-docs rule)

- **README.md** `### frontend: config block` (~line 193): add the `fields:` section to the YAML
  example with inline comment, and extend the null-disables convention paragraph to mention
  `fields.textareaThreshold: null`.
- **docs/specs/2026-06-04-frontend-pipeline-rebuild.md**: dated revision note in the FE-4/config
  area: `frontend.fields.textareaThreshold` added 2026-06-06, default 500, null disables;
  inference knobs now have a config home (`frontend.fields`).

## Quality gates (validator)

- `just test-unit` — all green, including the new cases.
- `just test-baseline` — must pass **unchanged** (default 500 ⇒ byte-identical output; any
  baseline diff means the default regressed).
- Typecheck clean (`bunx tsc --noEmit` or the repo's lint/typecheck target if one exists).
- Diff review: ladder order unchanged; strict `>` and unbounded short-circuit preserved;
  no stray changes outside the files listed above.

## Out of scope

- Per-entity threshold override (per-field `ui_type` already covers author intent).
- Configuring other inference heuristics (name-pattern email/url/money/percentage) — the
  `frontend.fields` section is their future home, but only the threshold ships now.
- EAV `data_type` mapping (no `max_length` exists there).
- Version bump / publish / PR — local-only work.
