# Surface fixtures

Real `codegen project surface --json` payloads of the Studio demo project (`src/studio/demo/`), not hand-written.
`surface-view.test.ts` reads them. Regenerate when the derivation's output for the demo changes:

| File | Project |
|---|---|
| `demo-surface.json` | `just studio-demo`, then `project surface --json` in `.studio-demo` |
| `demo-surface-with-relationship.json` | the demo after `PUT /api/relationships` writes `contact_opportunity` (the e2e's step 9) |
| `demo-surface-api-variants.json` | the demo with `api: { includes: { find_by_id: { max_depth: 1, paths: [contacts] } } }` appended to `account.yaml` and `api: false` appended to `opportunity.yaml` |
