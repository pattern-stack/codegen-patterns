# Surface fixtures

Real `codegen project surface --json` payloads of the Studio demo project (`src/studio/demo/`), not hand-written.
`surface-view.test.ts` reads them. Regenerate when the derivation's output for the demo changes:

| File | Project |
|---|---|
| `demo-surface.json` | `just studio-demo`, then `project surface --json` in `.studio-demo` |
| `demo-surface-with-relationship.json` | the demo after `PUT /api/relationships` writes `contact_opportunity` (the e2e's step 9) |
| `demo-surface-api-variants.json` | the demo with `api: { includes: { find_by_id: { max_depth: 1, paths: [contacts] } } }` appended to `account.yaml` and `api: false` appended to `opportunity.yaml` |

`family-graph.json` / `family-surface.json` are the real `codegen project graph --json` / `project surface --json` payloads
of the RFC-0006 family (`test/fixtures/inheritance/entities/`, config `runtime: vendored`, `paths.entities: entities`;
`sourcePath` made project-relative). `schema-adapter.test.ts` reads them to prove an `inherits:` line carries a relation id
the derived surface lists. Regenerate when either output changes for the family.

`spine-order-graph.json` is the real `codegen project graph --json` payload of `spine-order/entities/` (STUDIO-6): a base
`part`, `audio_part` and `text_part` inheriting it, each owned (cascade) by `recording` / `message` (config `runtime: vendored`,
`paths.entities: entities`; `sourcePath` made project-relative). `spine-order.test.ts` reads it to pin the spine choice under
both orders. Regenerate when the graph output changes for those YAMLs.
