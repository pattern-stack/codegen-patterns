## Gate 2.5 — Adherence (lens=adherence) · PR #911 @ fbb5e82a

**Against:** RFC-0006 §12 (A10, the rest of A2) + §13.2 S5 (plan, "as built", phase R, phase R2)
**Verdict:** PASS_WITH_NOTES

Reviewed `git diff dugshub/875-s4-inherits-writes...HEAD` in the worktree. The local tip, `5e2c06f2`, carries the same S5
diff as the PR head, `fbb5e82a`. With `index` lines dropped, the two diffs (`7a11b49d...5e2c06f2` and `edc04676...fbb5e82a`)
are byte-identical, 11,957 lines each. The remote stack was only rebased onto a newer `main`. Line numbers below are at
that tip. CI on `fbb5e82a` is green: `test-all` passed, and `test-integration` passed with 314 tests and 0 failures,
including all 23 cases in `inheritance-http.test.ts` and the two new statement-count cases in `inheritance-reads.test.ts`.

Both claimed acceptance items are met and have evidence. There are two should-fix findings. The first is a derived fact
that the generated code does not match. The second is three places where the RFC body says something S5 made false.

Not re-reported: #910's should-fix 1. A child service's `delete` still emits `<base>.deleted` for a live row of another
kind (`runtime/base-classes/base-service.ts:229-237`, no service `pair_delete`). It is still present at this tip, and
S5's `DELETE /meetings/:id` is the route that makes it reachable over HTTP. The fix belongs to S4. If it lands, its HTTP
case belongs in `inheritance-http.test.ts`.

### Blockers

None.

### Should-fix

1. `src/derived/api/entity.ts:895-897`: the derived delete pre-read is recorded for every entity, but only one template
   branch makes it.
   - **What the derivation says:** the R2-review fix gives **every** delete use case
     `alsoCalls: [findById]`, or `[findWithBase]` for a child.
   - **What the template does:** `templates/entity/new/backend/use-cases/delete.ejs.t:40` makes that call only in the
     `hasEmits && deleteEventType` branch. The other branch, `:74`, calls only `this.service.delete(id)`.
   - **Where it shows:** none of the 15 baseline delete use cases does a pre-read, including
     `delete-meeting.use-case.ts` and `delete-email.use-case.ts`. Yet 30 api-surface goldens now pin the `alsoCalls`.
     Studio prints it too: `tools/studio/src/inspector/surface-view.ts:221` joins `alsoCalls` into the use case's
     "calls" cell.
   - **Why no gate caught it:** the parity gate compares methods, use cases and routes, not `alsoCalls`.
   - **The RFC's claim has no compiled evidence.** No fixture child declares `emits:`, so no gate ever renders or
     compiles the child pre-read. That is RFC `:1686`: "the delete use case's pre-read (its derived `alsoCalls`) is
     `findWithBase` so a payload expression sees the flat row". The same holds for the child's `create` / `update`
     emits branches that return `<Child>Flat`. The only fixture with `emits:` is `contact-v2.yaml`.

   **Scenario:** Studio's API tab for `meeting` lists the delete use case as calling `MeetingService.delete,
   MeetingService.findWithBase`. The generated file calls only `this.service.delete(id)`. `codegen project surface`
   reports the same false call.

   **Fix:**
   - Record the pre-read only where it is made. Derive "the delete use case pre-reads" from the input that decides
     `deleteEventType`. That decision then moves into the derivation, and the template prints it.
   - Add `emits:` (created / updated / deleted) to a child in the render matrix and the smoke fixtures, so `tsc`
     compiles the flat payload path.
   - Make the RFC sentence say when the pre-read happens.

2. The RFC body says three things S5 made false. §13.3 says to fix the RFC in the same PR.
   - `docs/rfcs/RFC-0006-joined-table-inheritance.md:629-630` (§4.1): `KindRequiresChildError` is still described as
     "naming the child's create use case". S5 made it name the child's **route**, `createPath: POST ${routePath(plural)}`
     (`templates/_shared/inheritance.mjs:382`). `inheritance-writes.test.ts:484` asserts `'POST /meetings'`.
   - `:823` (§6): the base repository's `listKind` signature still has two parameters. S5 added a third, `childWith`, at
     `src/derived/api/entity.ts:473` and `repository.ejs.t:708`. Only the S5 "as built" bullet mentions it.
   - `:1126` (§13.1): the table gives `communication_part` two children. The fixture has three:
     `message_communication_part` (`as: message`, since S3). That third child is exactly why S5 gives
     `communication_part` no create route, which the S5 note and the test at `inheritance-http.test.ts:348` rely on. The
     header comment of all three fixture copies says the opposite: "`message` stays a base-only kind"
     (`test/fixtures/inheritance/entities/communication_part.yaml:4`, `test/scaffold/entities/communication-part-scaffold.yaml:5`,
     `test/smoke/fixtures/communication_part.yaml:5`).

   **Scenario:** a reader of §13.1 or the fixture expects `POST /communication_parts` to accept `kind: 'message'`. It is
   a 404. A reader of §6 calls `listKind` with two arguments and cannot find how a child list joins its includes.

   **Fix:** edit the three RFC passages and the three fixture comments. Comments are outside what
   `inheritance-fixtures-agree.test.ts` compares, so the copies stay in agreement.

### Nits

1. `templates/entity/new/backend/search-controller.ejs.t:64`: the child's search controller still declares
   `Promise<Page<Meeting>>` (baseline `meetings/meeting-search.controller.ts:32`). The use case returns
   `Page<MeetingFlat>`, and TypeScript accepts the upcast, so the declared type drops every base field. A10 is about
   the child's routes returning the flat shape. Print `<Entity>Flat` for a child, as `controller.ejs.t` does with `_W`.

   Related, recorded nowhere in the RFC: `GET /meetings/search` is unreachable over HTTP today (#767, open). The `:id`
   route is registered first (`meetings.module.ts:31`) and its `ParseUUIDPipe` answers 400. The child search and the
   `400 sort_not_combinable` are therefore only reachable through the use case, which is how
   `inheritance-http.test.ts:201-232` tests them. That was the right call, but the RFC and the PR body ("a base-column
   sort combined with a child filter is a `400`") should name #767.

2. `test/scaffold/tests/inheritance-http.test.ts:402,409`: the three error cases assert only `{ statusCode, code }`.
   The RFC note (`:1670-1682`) and the PR body claim more:
   - bodies in `ErrorResponseDto` shape, which includes `error` and the required `message`;
   - `kind` and `createPath` on `kind_requires_child`;
   - "the three errors with their bodies" (`:1694`).

   A regression that dropped `error`, `message` or `createPath` from `kindError` would pass. Assert the whole body per
   case with `toEqual`, since the stub fixes `err.message` and `err.createPath`.

3. `test/smoke/verify-openapi.ts:189-192`: the two checks that `communication_part` has no create have no positive
   control. If `CommunicationPartsModule` stopped being mounted, both would still pass. Assert that
   `paths['/communication_parts'].get` and `UpdateCommunicationPartDto` exist first, the way the integration test does
   with `GET /communication_parts` → 200.

4. `templates/entity/new/backend/use-cases/list.ejs.t:149-155`: `id`, `kind` and the tenant column exist on both
   tables, and they are classified as base columns first. So `search({ search: 'q', sort_by: 'id' })` is a
   `400 sort_not_combinable`, although the child-rooted read could order by `meetings.id`. The RFC wording ("names a
   base column") technically covers this, but the refusal is not needed. When a `where` applies, test the child's
   table first.

5. RFC `:1727`: "the use cases print `calls.method` / the `list_flat` / `count_flat` service entries instead of
   literals" is overstated. The new child-rooted branch prints `this.service.list(` and `this.service.count(` as
   literals (`list.ejs.t:220,227`). `alsoCalls` is also applied unevenly: it names `count` for a child's list use case
   but not for a plain entity's, which calls `count` too. Either print those from the surface, or narrow the sentence.

6. Living-doc drift:
   - **§11.1 OQ-5 `:1024`, `DECISION`.** The row still says "nested under its **kind** key". The build nests under
     the child's **relation** key. The two differ whenever `as:` is used: `CommunicationPartOfKindSchema` puts
     `transcriptCommunicationPart` under kind `meeting`. The S5 note reinterprets the row (`:1649`), and the behaviour
     dates from S3's `asKind`. But Doug decided OQ-5, so he should confirm the reading before the row is edited.
   - **§5 `:700-716`.** The sample uses `createCommunicationSchema` / `meetingOutputSchema` with inline child fields.
     The emitted names are `CreateCommunicationSchema` / `MeetingOutputSchema`, and the child's fields are spread from
     `MeetingOwnOutputSchema.omit({ id }).shape`.
   - **`:1638`.** The "Open follow-up, for Doug" on strict DTOs is now #914 (open). Cite it.
   - **§13.2 S5 plan `:1625`.** It names `test/scaffold/tests/http.test.ts`. The cases went into a new
     `inheritance-http.test.ts`. Say so in the as-built note.
   - **S2 as built `:1309`.** It still reads "`['inherits']` for a child" with no superseded marker. S4's matching line
     got one (`:1601`).
   - **Phase R golden list.** It says "`email`, `meeting` (their writes, search …)", but only `meeting` has a search.

### Checked and fine

- **Scope (§13.2 S5 "Must not touch").** No file under `runtime/` or `src/emitters/` is in the diff. Every other
  touched file is in the plan's list or explained by an as-built, phase R, R2 or R5-review note:
  - `src/derived/api/*`, `entity-locals.js`, `_shared/inheritance.mjs`;
  - `src/schema/inheritance.ts` and the validator's `resolveChoices` refactor;
  - Studio `surface-kinds.ts` / `surface-view.ts`;
  - `repository` / `service` / `module` / `index` templates;
  - `verify-openapi.ts`, the four `meeting.yaml` copies.
- **A10, flat child DTOs.**
  - `create.ejs.t:11-24` gives `Create<Base>Schema.omit({ kind }).extend(own fields)`. Update is `.partial()` of it.
  - `output.ejs.t:11-41` gives `<Child>OwnOutputSchema`, and the output is `<Base>OutputSchema.extend({ kind: literal,
    ...own.omit({ id }).shape })`.
  - Baseline `meetings/dto/*` matches. Evidence: `verify-openapi.ts:180-186`, the flat `MeetingOutputDto` with no
    nested `communication`.
- **A10, flat child routes.** Each route reads the flat path, and each test passed in CI:
  - `POST`, `GET /:id` (`findWithBase`), `GET` list (`listFlat`, or child-rooted with `flattenBase`), `PATCH`;
  - `DELETE` removes both rows;
  - `?include=transcripts` is flat with no base key;
  - a base-column sort and a child-column sort;
  - the default sort, with `total` counting only this kind;
  - see `inheritance-http.test.ts:118-272`.
- **A10, the base's create accepts only base-only kinds.**
  - `entity-locals.js:2659-2666` gives `z.enum(['message'])` (baseline `create-communication.dto.ts`). `POST
    /communications` with `meeting` / `email` is a 400 that writes nothing (`:328-337`).
  - When every kind has a child, there is no create use case, route or provider, and no registered `Create<Base>Dto`.
    `createDisabledBy` decides it (`entity.ts:132-147`), the derivation reads it (`:837-889`, `:992-994`), and the
    module (`module.ejs.t:13-17`) and controller (`controller.ejs.t:20-24`) print it.
  - Evidence: `inheritance-http.test.ts:348-359`, `verify-openapi.ts:188-192`, `writes-disabled-by.test.ts`
    (`createDisabledBy` cases plus the unknown-kinds throw), and the `matrix-family-every-kind-has-child` goldens.
- **The rest of A2.** CI `test-all` on `fbb5e82a` ran `test-baseline` (which covers `tsc`) and `test-smoke` (the whole
  family, now with child writes, search and flat DTOs) green.
- **Unknown keys stripped, not 400.** `kind` and the tenant column in a body set nothing (`inheritance-http.test.ts:274-301`,
  rows asserted). A derived `match:` column is ignored (`:303-314`). This matches the as-built note, and the move to
  `.strict()` is #914.
- **Error mapping in the generated controller** (`controller.ejs.t:259-270`), with no `runtime/` change:
  `kind_immutable` → 400, `kind_requires_child` → 400, `kind_mismatch` → 409. An unowned error stays a 500
  (`inheritance-http.test.ts:418-426`). The include-400 body gained `statusCode` / `error`. The smoke regex was updated
  to the exact new body (`run-smoke.ts:771`) at the same strength.
- **One statement per read (charter I4).** A child list with an include is one statement, and so is the child-rooted
  list (`inheritance-reads.test.ts:335-369`, counting client, with a passing control at the top of the block).
- **ADR-046.**
  - `listFlat` / `countFlat` are their own kinds `list_flat` / `count_flat`, with `delegatesTo` naming the base's
    `listKind` / `countKind`. The repository and service templates print `m.name` / `m.delegatesTo.method`.
  - `checkDelegate` now walks both layers and names the right class (`project.ts:187-211`, `has-many-delegate.test.ts`).
  - `discriminatorKindsOf` is a required input and fails closed (`createDisabledBy` throws on `null`).
  - `enumChoices` is the single choices resolver for the validator, the derivation and `resolveEnumField`, and
    `baseOnlyKinds` the single computation for the DTO `z.enum` and `createDisabledBy`.
- **`<Base>OfKindSchema`** is in its own file (`dto/of-kind.ejs.t`) and is not registered with OpenAPI. No route
  returns it, as the note says.
- **Fixture sets.** The four `meeting.yaml` copies carry an identical `queries: search` + `api.includes.list` block.
- **The new test file runs in CI.** `run-integration.ts:142` runs the whole `test/scaffold/tests/` directory, so
  `inheritance-http.test.ts` is picked up.
