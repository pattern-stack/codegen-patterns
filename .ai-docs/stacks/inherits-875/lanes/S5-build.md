# Lane `inh-s5-build` — #875 slice S5: DTOs, use cases, controllers

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/inherits-875/lanes/COMMON.md` first; it binds you.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-875-s5-inherits-http`
- **Branch:** `dugshub/875-s5-inherits-http`, stacked on `dugshub/875-s4-inherits-writes`. **Diff base:
  `dugshub/875-s4-inherits-writes`** (use it in place of `main` everywhere COMMON.md says `main`).
- **Your scope:** RFC-0006 §13.2 **S5**, revision 3, **plus** what S4 deferred to you: a child's write use cases and
  HTTP write routes (S4 kept them off because the flat DTOs are yours). Read §5 (all), §3.2–§3.3 (`findWithBase`,
  `listKind`), §4.1's base guards, and every "as built" note S1–S4 left in the RFC.

## What to build

1. **Child DTOs are flat** (`templates/entity/new/backend/dto/*.ejs.t`): the base's schemas are the owner and the
   child extends them — `create<Child>Schema = create<Base>Schema.omit({ kind }).extend({ …child fields })`; update is
   `.partial()` of it as today; output `= <base>OutputSchema.extend({ kind: z.literal('<as>'), …child fields })`. Never
   client input: `kind`, the tenant column, derived `match:` columns. Import the base's DTO module; do not re-declare
   a base field.
2. **The base's DTOs:** create's `kind` is `z.enum([<base-only kinds>])`; if every kind has a child, the base has no
   create use case or route. One extra output, `<base>OfKindSchema` — a `z.discriminatedUnion('kind', …)` with each
   child's own output nested under its kind key and the base-only kinds bare (§5).
3. **Use cases** (`use-cases/*.ejs.t`): re-enable the child's create / update / delete; a child's find-by-id uses
   `findWithBase`, its list uses the base's `listKind` (the list's default sort `created_at desc, id desc` and the
   sort-column check `list.ejs.t:97-111` must use the **base's** columns for a child). Errors: map
   `KindImmutableError`, `KindRequiresChildError` and `KindMismatchError` to HTTP responses the way existing domain
   errors are mapped (find that mechanism; do not invent a parallel one). Choose the status codes, justify them in
   the RFC, and say if the mapping needs a change under `runtime/` (S5 must not touch `runtime/` — if it is
   unavoidable, stop and report).
4. **Controller** (`controller.ejs.t`): a child's routes return the flat shape; the include allowlist (`api.includes`,
   charter I6) applies unchanged and `communication` never needs allowlisting on the child (it is in the body).
5. **OpenAPI:** whatever the OpenAPI emission reads must describe the flat child outputs and the base's union output
   (`just test-smoke` checks openapi — keep it green and make the union visible in it).
6. **Frontend note** (RFC, from S2's review): the frontend emitter does not read `generate.writes`; with child writes
   now real routes, check the frontend still compiles (`just test-smoke-frontend`) — the graph work itself is S6.
7. **HTTP tests** in `test/scaffold/tests/http.test.ts` (or a new `inheritance-http.test.ts` beside it — follow the
   existing pattern): `POST /meetings` with a flat body creates both rows and returns the flat shape;
   `GET /meetings/:id` and `GET /meetings` return flat rows sorted on a base column; `PATCH /meetings/:id` across both
   tables; a `kind` in a PATCH body is refused; `DELETE /meetings/:id` removes both; the base's `POST
   /communications` accepts a base-only kind and refuses a kind that has a child; a body carrying `kind`, the tenant
   column or a derived `match:` column cannot set them. Prove one gate fails on its subject (e.g. make the child's
   find-by-id use `findById` instead of `findWithBase` and watch the flat-shape case go red; restore).

8. **Stale comment from S4:** the generated child repository ends with `// Inherited from BaseRepository: …
   create, update, delete, upsertMany` although it overrides `create` / `update` / `delete`. List only what is
   actually inherited (find the template line that writes it).

## Must not touch

`runtime/`; the relations emitter; the S3 read surface and the S4 write surface except to call them.

## Gates (after your last edit; paste tails)

`bun run typecheck`, `just test-unit`, `just test-baseline` (list changed pre-existing snapshots by category; #680
untouched), `just test-smoke` (incl. its openapi step), `just test-integration`, `just test-smoke-frontend`.

## Report

Per COMMON.md. Include `create-meeting.dto.ts`, `meeting-output.dto.ts` and the base's `<base>OfKindSchema`
verbatim, and the error → status mapping you chose.
