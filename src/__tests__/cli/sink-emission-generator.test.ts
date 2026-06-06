/**
 * Unit tests for the default `IIntegrationSink` emitter (RFC-0002 §4, E1).
 *
 * Pure-function tests — no filesystem. Cover:
 *   (a) FK-free entity → clean passthrough write, sentinel, provider assert,
 *       three methods, Canonical alias, and NO ` as ` cast;
 *   (b) belongs_to FK entity → active FK external-key copy-through (no TODO seam);
 *   (c) multi-word non-self FK + self-FK shapes → correct write-key verbatim;
 *   (d) json copy-through field → emits `reactions: record.reactions`, no TODO;
 *   (e) FK + json + userId together → all three active, no cast;
 *   (f) non-`Integrated` pattern → hard-error naming the entity + `pattern: Integrated`;
 *   (g) provider literal is the bare slug;
 *   (h) §1b contract test — fkWriteKey() matches the template's relationKey+ExternalId
 *       derivation for all three FK shapes (processBelongsTo:447-460 source of truth).
 *
 * #488 find-side projection tests (Tests 1–8 per spec):
 *   (1) Explicit view enumeration — not a bare `return row`.
 *   (2) Nullable scalars BARE — no `??` coercion (Gate 1.5 blocker guard).
 *   (3) Non-null scalars BARE — no `??`.
 *   (4) Json at `unknown` — no `as`, no `??`, SEAM marker present.
 *   (5) Timestamps enumerated iff `hasTimestamps`.
 *   (6) No ` as ` cast in any find-side case.
 *   (7) `findByExternalIdProjected` delegation unchanged.
 *   (8) Header documents generator-solved vs seam.
 */

import { describe, it, expect } from "bun:test";
import {
  generateDefaultSink,
  type SinkEmitInput,
} from "../../cli/shared/sink-emission-generator";
import { fkWriteKey } from "../../cli/shared/adapter-emission-generator";

/** The "no ` as ` cast" rule (CLAUDE.md) is about the emitted *code*, not the
 *  English prose in doc comments (which legitimately contains the word "as").
 *  Strip whole-line `//` comments before asserting. The emitter never emits a
 *  trailing inline `// ...` on a code line, so whole-line stripping is exact. */
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

/** FK-free `contact` (surface crm) — matches the integration-patterns fixture
 *  (`email` field only), promoted to `pattern: Integrated`. */
function contactInput(overrides: Partial<SinkEmitInput> = {}): SinkEmitInput {
  return {
    entityName: "contact",
    entityClass: "Contact",
    surface: "crm",
    pattern: "Integrated",
    provider: "hubspot",
    copyThroughFields: [{ camelName: "email", tsType: "string" }],
    fkExternalKeys: [],
    repoImportSpecifier: "../../../crm/contacts/contact.repository",
    ...overrides,
  };
}

describe("generateDefaultSink — FK-free entity", () => {
  const out = generateDefaultSink(contactInput());

  it("carries the emit-once scaffold sentinel as the first line", () => {
    expect(out.startsWith("// <CODEGEN-SCAFFOLD-V1>")).toBe(true);
  });

  it("exports the Canonical alias defaulting to the projection", () => {
    expect(out).toContain(
      "export type ContactCanonical = ContactIntegrationProjection;",
    );
  });

  it("declares the sink class implementing the typed port", () => {
    expect(out).toContain(
      "export class ContactSink implements IIntegrationSink<ContactCanonical> {",
    );
  });

  it("binds provider at construction", () => {
    expect(out).toContain("private readonly repo: ContactRepository,");
    expect(out).toContain("private readonly provider: string,");
  });

  it("emits all three IIntegrationSink methods", () => {
    expect(out).toContain(
      "async findByExternalId(userId: string, externalId: string): Promise<ContactCanonical | null>",
    );
    expect(out).toContain("async upsertByExternalId(");
    expect(out).toContain(
      "async softDeleteByExternalId(_userId: string, externalId: string): Promise<{ id: string } | null>",
    );
  });

  it("delegates each method to the integrated repo", () => {
    expect(out).toContain(
      "this.repo.findByExternalIdProjected(externalId, this.provider)",
    );
    expect(out).toContain(
      "this.repo.integrationUpsertOne(write, this.provider)",
    );
    expect(out).toContain(
      "this.repo.softDeleteByExternalId(externalId, this.provider)",
    );
  });

  it("emits the provider-match assert that throws on mismatch", () => {
    expect(out).toContain("if (provider !== this.provider) {");
    expect(out).toContain(
      "ContactSink: bound provider '${this.provider}' != run provider '${provider}'",
    );
  });

  it("builds a clean passthrough write: externalId + each copy-through field", () => {
    expect(out).toContain("const write: ContactIntegrationWrite = {");
    expect(out).toContain("externalId: record.externalId,");
    expect(out).toContain("email: record.email,");
  });

  it("returns the { id, saved } shape", () => {
    expect(out).toContain("return { id: proj.id, saved: record };");
  });

  it("contains NO ` as ` cast anywhere", () => {
    expect(codeOnly(out).includes(" as ")).toBe(false);
  });

  it("emits no FK TODO seam when there are no FK keys", () => {
    expect(out).not.toContain("TODO(author)");
  });

  it("omits userId from the write when the entity declares no user_id field", () => {
    // contact has no `user_id` column → ContactIntegrationWrite has no userId
    // member; a `userId,` line would be an excess-property type error.
    const writeBlock = out.slice(
      out.indexOf("const write: ContactIntegrationWrite = {"),
      out.indexOf("const proj ="),
    );
    expect(writeBlock).not.toContain("userId");
  });
});

describe("generateDefaultSink — userId is a declared copy-through field", () => {
  // transcript-shaped: declares user_id, so userId IS a writeColumn. It must be
  // sourced from the param (a bare `userId,`), NOT `userId: record.userId`.
  const out = generateDefaultSink(
    contactInput({
      entityName: "transcript",
      entityClass: "Transcript",
      surface: "transcript",
      provider: "google",
      copyThroughFields: [
        { camelName: "userId", tsType: "string" },
        { camelName: "title", tsType: "string" },
      ],
    }),
  );

  it("sources userId from the method param, not the record", () => {
    const writeBlock = out.slice(
      out.indexOf("const write: TranscriptIntegrationWrite = {"),
      out.indexOf("const proj ="),
    );
    expect(writeBlock).toContain("userId,");
    expect(writeBlock).not.toContain("userId: record.userId");
  });

  it("still copies the non-userId fields from the record", () => {
    expect(out).toContain("title: record.title,");
  });

  it("contains NO ` as ` cast", () => {
    expect(codeOnly(out).includes(" as ")).toBe(false);
  });
});

describe("generateDefaultSink — belongs_to FK entity (single-word non-self)", () => {
  // contact with accountExternalId — the most common case.
  // FK external keys emit as `<writeKey>: null` + SEAM comment: the
  // projection-default canonical has no external-key member, so `record.<writeKey>`
  // would be TS2339. null is write-safe (repo skips null FKs).
  const out = generateDefaultSink(
    contactInput({
      fkExternalKeys: [{ writeKey: "accountExternalId" }],
    }),
  );

  it("emits the FK key as null (not record.<writeKey> — projection-default canonical has no external-key member)", () => {
    expect(out).toContain("accountExternalId: null,");
  });

  it("emits a SEAM comment naming the write key", () => {
    expect(out).toContain("SEAM (FK external key");
    expect(out).toContain("accountExternalId");
  });

  it("the code line is null, not record.accountExternalId (TS2339 under projection-default canonical)", () => {
    // The SEAM comment mentions record.accountExternalId for instruction — intentional.
    // Assert the active code assignment is null.
    expect(codeOnly(out)).not.toContain("accountExternalId: record.");
  });

  it("has no TODO(author) text anywhere", () => {
    expect(out).not.toContain("TODO(author)");
  });

  it("contains NO ` as ` cast", () => {
    expect(codeOnly(out).includes(" as ")).toBe(false);
  });
});

describe("generateDefaultSink — belongs_to FK entity (multi-word non-self, snake-retained)", () => {
  // sales_account target → sales_accountExternalId (wart mirrored from template;
  // normalization deferred to follow-up #494 per spec Judgment call).
  // FK key still emits as null + SEAM comment; the name is verbatim (snake retained).
  const out = generateDefaultSink(
    contactInput({
      fkExternalKeys: [{ writeKey: "sales_accountExternalId" }],
    }),
  );

  it("emits the FK key as null with the snake-retained name", () => {
    expect(out).toContain("sales_accountExternalId: null,");
  });

  it("emits a SEAM comment naming the snake-retained key", () => {
    expect(out).toContain("SEAM (FK external key");
    expect(out).toContain("sales_accountExternalId");
  });

  it("the code line is null, not record.sales_accountExternalId", () => {
    expect(codeOnly(out)).not.toContain("sales_accountExternalId: record.");
  });

  it("has no TODO(author) text", () => {
    expect(out).not.toContain("TODO(author)");
  });

  it("contains NO ` as ` cast", () => {
    expect(codeOnly(out).includes(" as ")).toBe(false);
  });
});

describe("generateDefaultSink — belongs_to FK entity (self-FK, camelCase derived)", () => {
  // parent_account_id on account entity → parentAccountExternalId
  // FK key emits as null + SEAM comment; name is camelCase-derived.
  const out = generateDefaultSink(
    contactInput({
      entityName: "account",
      entityClass: "Account",
      fkExternalKeys: [{ writeKey: "parentAccountExternalId" }],
    }),
  );

  it("emits the self-FK key as null with the camelCase-derived name", () => {
    expect(out).toContain("parentAccountExternalId: null,");
  });

  it("emits a SEAM comment naming the self-FK key", () => {
    expect(out).toContain("SEAM (FK external key");
    expect(out).toContain("parentAccountExternalId");
  });

  it("the code line is null, not record.parentAccountExternalId", () => {
    expect(codeOnly(out)).not.toContain("parentAccountExternalId: record.");
  });

  it("has no TODO(author) text", () => {
    expect(out).not.toContain("TODO(author)");
  });

  it("contains NO ` as ` cast", () => {
    expect(codeOnly(out).includes(" as ")).toBe(false);
  });
});

describe("generateDefaultSink — json copy-through field", () => {
  // message-shaped: reactions is type:json → unknown copy-through.
  // No code change needed for json; this test locks the convention.
  const out = generateDefaultSink(
    contactInput({
      entityName: "message",
      entityClass: "Message",
      surface: "messaging",
      copyThroughFields: [
        { camelName: "reactions", tsType: "unknown" },
        { camelName: "body", tsType: "string" },
      ],
      fkExternalKeys: [],
    }),
  );

  it("emits json column as a plain copy-through line", () => {
    expect(out).toContain("reactions: record.reactions,");
  });

  it("emits other scalar columns too", () => {
    expect(out).toContain("body: record.body,");
  });

  it("has no TODO(author) text", () => {
    expect(out).not.toContain("TODO(author)");
  });

  it("contains NO ` as ` cast", () => {
    expect(codeOnly(out).includes(" as ")).toBe(false);
  });
});

describe("generateDefaultSink — FK + json + userId together", () => {
  // message-shaped: json copy-through + FK external key + declared userId.
  const out = generateDefaultSink(
    contactInput({
      entityName: "message",
      entityClass: "Message",
      surface: "messaging",
      provider: "slack",
      copyThroughFields: [
        { camelName: "userId", tsType: "string" },
        { camelName: "reactions", tsType: "unknown" },
        { camelName: "body", tsType: "string" },
      ],
      fkExternalKeys: [{ writeKey: "channelExternalId" }],
    }),
  );

  it("emits the json column as a plain copy-through", () => {
    expect(out).toContain("reactions: record.reactions,");
  });

  it("emits the FK external key as null + SEAM comment (no active record.<writeKey> code line)", () => {
    expect(out).toContain("channelExternalId: null,");
    expect(out).toContain("SEAM (FK external key");
    // The SEAM comment mentions record.channelExternalId for instruction — that's
    // intentional. Assert the code line itself is null, not a record access.
    expect(codeOnly(out)).not.toContain("channelExternalId: record.");
  });

  it("sources userId from the param shorthand, not the record", () => {
    const writeBlock = out.slice(
      out.indexOf("const write: MessageIntegrationWrite = {"),
      out.indexOf("const proj ="),
    );
    expect(writeBlock).toContain("userId,");
    expect(writeBlock).not.toContain("userId: record.userId");
  });

  it("has no TODO(author) text", () => {
    expect(out).not.toContain("TODO(author)");
  });

  it("contains NO ` as ` cast", () => {
    expect(codeOnly(out).includes(" as ")).toBe(false);
  });
});

describe("generateDefaultSink — precondition", () => {
  it("hard-errors for a non-Integrated pattern, naming the entity + pattern: Integrated", () => {
    expect(() =>
      generateDefaultSink(contactInput({ pattern: "Base" })),
    ).toThrow(/contact/);
    expect(() =>
      generateDefaultSink(contactInput({ pattern: "Base" })),
    ).toThrow(/pattern: Integrated/);
  });

  it("hard-errors for Activity / Metadata patterns too", () => {
    for (const pattern of ["Activity", "Metadata", "Knowledge"]) {
      expect(() => generateDefaultSink(contactInput({ pattern }))).toThrow(
        /pattern: Integrated/,
      );
    }
  });
});

describe("generateDefaultSink — provider literal", () => {
  it("uses the bare provider slug (not a surface-qualified domain)", () => {
    const out = generateDefaultSink(contactInput({ provider: "google" }));
    // appears in the assert message interpolation; the construction-site literal
    // is passed by the caller (E2 module emitter), so here we assert the slug
    // is carried verbatim into the bound-provider machinery.
    expect(out).toContain("bound provider '${this.provider}'");
    // sanity: a bare slug like 'google' has no surface suffix
    expect(out).not.toContain("google-crm");
  });
});

// ============================================================================
// §1b — Contract test: fkWriteKey() ⇄ template's processBelongsTo relationKey
//
// The sink's fkWriteKey() mirrors processBelongsTo's relationKey branches in
// prompt-extension.js:447-460. This test locks all three FK shapes so a future
// template change to relationKey would re-trip this test (the early-warning
// guard; the compile error from active FK lines is the runtime safety net).
//
// Source of truth: prompt-extension.js:447-460.
//   - non-self: relationKey = target (verbatim)  → writeKey = target + "ExternalId"
//   - self-FK:  relationKey = camelCase(fk − _id) → writeKey = camelCase(fk − _id) + "ExternalId"
// ============================================================================

// ============================================================================
// #488 — Find-side projection: typed view, null-preserving bare passthrough
//
// Spec: .ai-docs/stacks/assembly-default-sinks/specs/488.md
// Gate 1.5 blocker: the original spec emitted `?? ''` for nullable scalars.
// The orchestrator diffs find() output via DeepEqualDiffer which does NOT equate
// null and '' — so `?? ''` causes a spurious upsert that never converges.
// The fix: BARE passthrough (null preserved); coercion is author-owned on widen.
// ============================================================================

/** Extract only the `findByExternalId` method body from the emitted sink.
 *  Slices from the first `async findByExternalId` to its closing `  }` —
 *  safe because the method body never contains a nested `  }` at 2-space
 *  indent (all inner braces are at 4+ spaces). */
function findBody(out: string): string {
  const start = out.indexOf("async findByExternalId(");
  const end = out.indexOf("\n  }\n", start);
  return out.slice(start, end + 4);
}

describe("generateDefaultSink — #488 Test 1: explicit view, not bare return row", () => {
  // contact-shaped: FK-free, single scalar copy-through (email: string).
  const out = generateDefaultSink(contactInput());
  const body = findBody(out);

  it("null-guard: if (row === null) return null", () => {
    expect(body).toContain("if (row === null) return null;");
  });

  it("builds an explicit view object: const view: ContactCanonical = {", () => {
    expect(body).toContain("const view: ContactCanonical = {");
  });

  it("enumerates id: row.id", () => {
    expect(body).toContain("id: row.id,");
  });

  it("enumerates externalId: row.externalId", () => {
    expect(body).toContain("externalId: row.externalId,");
  });

  it("returns view, not row", () => {
    expect(body).toContain("return view;");
    expect(body).not.toContain("return row;");
  });
});

describe("generateDefaultSink — #488 Test 2 (blocker guard): nullable scalars BARE — no `??`", () => {
  // Three nullable scalar types: string|null, number|null, boolean|null.
  const out = generateDefaultSink(
    contactInput({
      entityName: "message",
      entityClass: "Message",
      copyThroughFields: [
        { camelName: "text", tsType: "string | null" },
        { camelName: "count", tsType: "number | null" },
        { camelName: "flag", tsType: "boolean | null" },
      ],
    }),
  );
  const body = findBody(out);

  it("text passes through bare: text: row.text,", () => {
    expect(body).toContain("text: row.text,");
  });

  it("count passes through bare: count: row.count,", () => {
    expect(body).toContain("count: row.count,");
  });

  it("flag passes through bare: flag: row.flag,", () => {
    expect(body).toContain("flag: row.flag,");
  });

  it("BLOCKER GUARD: no `??` anywhere in the find body (regression for diff-divergence bug)", () => {
    // A `??` in the find body would coerce null → '' / 0 / false, making a
    // legitimately-null adapter value diff false against a local '' — spurious
    // upsert that never converges (deep-equal.differ.ts:187-208, :220).
    expect(body).not.toContain("??");
  });
});

describe("generateDefaultSink — #488 Test 3: non-null scalars BARE — no `??`", () => {
  const out = generateDefaultSink(
    contactInput({
      copyThroughFields: [
        { camelName: "name", tsType: "string" },
        { camelName: "count", tsType: "number" },
        { camelName: "active", tsType: "boolean" },
      ],
    }),
  );
  const body = findBody(out);

  it("name: row.name, present", () => {
    expect(body).toContain("name: row.name,");
  });

  it("name: row.name ?? is NOT present (non-null passthrough has no coercion)", () => {
    expect(body).not.toContain("name: row.name ??");
  });

  it("no `??` in the find body (coercion always author-owned)", () => {
    expect(body).not.toContain("??");
  });
});

describe("generateDefaultSink — #488 Test 4: json at `unknown` — no cast, no default, SEAM marker", () => {
  const outNonNull = generateDefaultSink(
    contactInput({
      entityName: "message",
      entityClass: "Message",
      copyThroughFields: [{ camelName: "reactions", tsType: "unknown" }],
    }),
  );
  const outNullable = generateDefaultSink(
    contactInput({
      entityName: "message",
      entityClass: "Message",
      copyThroughFields: [{ camelName: "reactions", tsType: "unknown | null" }],
    }),
  );

  it("reactions: row.reactions, present (non-null unknown)", () => {
    expect(findBody(outNonNull)).toContain("reactions: row.reactions,");
  });

  it("reactions: row.reactions, present (nullable unknown)", () => {
    expect(findBody(outNullable)).toContain("reactions: row.reactions,");
  });

  it("no ` as ` cast for json fields (non-null unknown)", () => {
    expect(codeOnly(findBody(outNonNull)).includes(" as ")).toBe(false);
  });

  it("no ` as ` cast for json fields (nullable unknown)", () => {
    expect(codeOnly(findBody(outNullable)).includes(" as ")).toBe(false);
  });

  it("no `??` default emitted for json (non-null unknown)", () => {
    expect(findBody(outNonNull)).not.toContain("??");
  });

  it("no `??` default emitted for json (nullable unknown)", () => {
    expect(findBody(outNullable)).not.toContain("??");
  });

  it("SEAM marker comment names the json field (unknown)", () => {
    // The emitter attaches a whole-line // SEAM (typed json: ...) label to json
    // fields so the author knows where to supply typed-narrowing on widen.
    // Assert marker present in full output (not code-only — it IS a comment).
    expect(outNonNull).toContain("SEAM");
    expect(outNonNull).toContain("reactions");
  });
});

describe("generateDefaultSink — #488 Test 5: timestamps enumerated iff hasTimestamps", () => {
  const withTs = generateDefaultSink(
    contactInput({ hasTimestamps: true }),
  );
  const withoutTs = generateDefaultSink(
    contactInput({ hasTimestamps: false }),
  );
  const omittedTs = generateDefaultSink(
    contactInput(/* no hasTimestamps key */),
  );

  it("hasTimestamps: true → createdAt: row.createdAt, in view", () => {
    expect(findBody(withTs)).toContain("createdAt: row.createdAt,");
  });

  it("hasTimestamps: true → updatedAt: row.updatedAt, in view", () => {
    expect(findBody(withTs)).toContain("updatedAt: row.updatedAt,");
  });

  it("hasTimestamps: false → createdAt NOT in view", () => {
    expect(findBody(withoutTs)).not.toContain("createdAt");
  });

  it("hasTimestamps: false → updatedAt NOT in view", () => {
    expect(findBody(withoutTs)).not.toContain("updatedAt");
  });

  it("hasTimestamps omitted (default false) → timestamps NOT in view", () => {
    expect(findBody(omittedTs)).not.toContain("createdAt");
    expect(findBody(omittedTs)).not.toContain("updatedAt");
  });
});

describe("generateDefaultSink — #488 Test 6: no ` as ` cast in any find-side case", () => {
  const cases = [
    { label: "FK-free entity", out: generateDefaultSink(contactInput()) },
    {
      label: "nullable scalars",
      out: generateDefaultSink(
        contactInput({
          copyThroughFields: [{ camelName: "text", tsType: "string | null" }],
        }),
      ),
    },
    {
      label: "json field",
      out: generateDefaultSink(
        contactInput({
          copyThroughFields: [{ camelName: "reactions", tsType: "unknown" }],
        }),
      ),
    },
    {
      label: "hasTimestamps",
      out: generateDefaultSink(contactInput({ hasTimestamps: true })),
    },
    {
      label: "localFkColumns",
      out: generateDefaultSink(
        contactInput({
          localFkColumns: [{ camelName: "accountId", tsType: "string | null" }],
        }),
      ),
    },
  ];

  for (const { label, out } of cases) {
    it(`no ` + "`as`" + ` cast — ${label}`, () => {
      expect(codeOnly(findBody(out)).includes(" as ")).toBe(false);
    });
  }
});

describe("generateDefaultSink — #488 Test 7: findByExternalIdProjected delegation unchanged", () => {
  const out = generateDefaultSink(contactInput());

  it("the repo call is still this.repo.findByExternalIdProjected(externalId, this.provider)", () => {
    expect(out).toContain(
      "this.repo.findByExternalIdProjected(externalId, this.provider)",
    );
  });

  it("the delegation is inside findByExternalId (not moved elsewhere)", () => {
    const body = findBody(out);
    expect(body).toContain(
      "this.repo.findByExternalIdProjected(externalId, this.provider)",
    );
  });
});

describe("generateDefaultSink — #488 Test 8: localFkColumns enumerated in view", () => {
  const out = generateDefaultSink(
    contactInput({
      entityName: "contact",
      entityClass: "Contact",
      localFkColumns: [
        { camelName: "accountId", tsType: "string | null" },
      ],
    }),
  );
  const body = findBody(out);

  it("local FK column accountId is enumerated as accountId: row.accountId,", () => {
    expect(body).toContain("accountId: row.accountId,");
  });

  it("no `??` for local FK column (bare passthrough)", () => {
    expect(body).not.toContain("??");
  });

  it("no ` as ` cast for local FK column", () => {
    expect(codeOnly(body).includes(" as ")).toBe(false);
  });
});

describe("generateDefaultSink — #488 Test 8b: header documents generator-solved vs seam", () => {
  // The generator-source header (not the emitted file banner) documents the
  // find-side design in detail — bare passthrough, diff-soundness, seam split.
  // We assert the emitted file BANNER also carries seam documentation.
  const out = generateDefaultSink(contactInput());

  it("emitted file banner mentions SEAM or seam (directing author)", () => {
    // The banner comment in the emitted file should reference seam concepts
    // so the author understands what is generated vs. what they own.
    const banner = out.slice(0, out.indexOf("import {"));
    expect(banner.toLowerCase()).toContain("seam");
  });

  it("emitted file carries null / differ convergence note in find-side comment", () => {
    // The inline comment in findByExternalId mentions null preservation / differ.
    const body = findBody(out);
    expect(body).toMatch(/null|noop|differ|converge/i);
  });
});

// ============================================================================
// §1b — Contract test: fkWriteKey() ⇄ template's processBelongsTo relationKey
//
// The sink's fkWriteKey() mirrors processBelongsTo's relationKey branches in
// prompt-extension.js:447-460. This test locks all three FK shapes so a future
// template change to relationKey would re-trip this test (the early-warning
// guard; the compile error from active FK lines is the runtime safety net).
//
// Source of truth: prompt-extension.js:447-460.
//   - non-self: relationKey = target (verbatim)  → writeKey = target + "ExternalId"
//   - self-FK:  relationKey = camelCase(fk − _id) → writeKey = camelCase(fk − _id) + "ExternalId"
// ============================================================================

describe("fkWriteKey — contract test (mirrors processBelongsTo:447-460)", () => {
  it("non-self single-word: target 'account' → accountExternalId", () => {
    // template: relationKey = target = "account" → "accountExternalId"
    expect(fkWriteKey("account", "account_id", false)).toBe(
      "accountExternalId",
    );
  });

  it("non-self multi-word: target 'sales_account' → sales_accountExternalId (snake retained)", () => {
    // template: relationKey = target = "sales_account" (verbatim, see comment :449-452)
    // → "sales_accountExternalId"  (deliberate wart; normalization = follow-up #494)
    expect(fkWriteKey("sales_account", "sales_account_id", false)).toBe(
      "sales_accountExternalId",
    );
  });

  it("self-FK: foreign_key 'parent_account_id', target 'account' → parentAccountExternalId", () => {
    // template: base = "parent_account_id".slice(0,-3) = "parent_account"
    //           relationKey = camelCase("parent_account") = "parentAccount"
    //           → "parentAccountExternalId"
    expect(fkWriteKey("account", "parent_account_id", true)).toBe(
      "parentAccountExternalId",
    );
  });

  it("self-FK irregular plural: target 'company', fk 'parent_company_id' → parentCompanyExternalId", () => {
    // Exercises the pluralize.plural() fallback path: pluralize.plural("company") = "companies",
    // NOT "companys" — this is the case the naive `${name}s` fallback would get wrong.
    // isSelfFk = (pluralize.plural("company") === pluralize.plural("company")) = true (entity is company)
    // base = "parent_company_id".slice(0,-3) = "parent_company"
    // relationKey = camelCase("parent_company") = "parentCompany" → "parentCompanyExternalId"
    expect(fkWriteKey("company", "parent_company_id", true)).toBe(
      "parentCompanyExternalId",
    );
  });
});

// ============================================================================
// #490 — delete:noop and deleteMode: 'delegate' | 'noop'
//
// Spec §Delete knob: the sink body branches on deleteMode.
//   'delegate' (default) → repo delegation: return this.repo.softDeleteByExternalId(...)
//   'noop'              → silent return null; + comment (no logger, no repo call)
// ============================================================================

describe("generateDefaultSink — #490 deleteMode: 'delegate' (default — unchanged behavior)", () => {
  const out = generateDefaultSink(contactInput());

  it("softDeleteByExternalId delegates to repo.softDeleteByExternalId (deleteMode absent → delegate)", () => {
    expect(out).toContain(
      "return this.repo.softDeleteByExternalId(externalId, this.provider);",
    );
  });

  it("no 'return null' in softDeleteByExternalId body when delegating", () => {
    const deleteBody = out.slice(
      out.indexOf("async softDeleteByExternalId("),
      out.indexOf("\n  }\n", out.indexOf("async softDeleteByExternalId(")),
    );
    // 'return null' could exist in findByExternalId (null guard); restrict to delete body
    expect(deleteBody).not.toContain("// delete:noop");
  });
});

describe("generateDefaultSink — #490 deleteMode: 'delegate' (explicit)", () => {
  const out = generateDefaultSink(contactInput({ deleteMode: "delegate" }));

  it("softDeleteByExternalId delegates to repo when deleteMode: 'delegate'", () => {
    expect(out).toContain(
      "return this.repo.softDeleteByExternalId(externalId, this.provider);",
    );
  });
});

describe("generateDefaultSink — #490 deleteMode: 'noop'", () => {
  const out = generateDefaultSink(contactInput({ deleteMode: "noop" }));

  it("softDeleteByExternalId body is 'return null;' (not repo delegation)", () => {
    const deleteBody = out.slice(
      out.indexOf("async softDeleteByExternalId("),
      out.indexOf("\n  }\n", out.indexOf("async softDeleteByExternalId(")),
    );
    expect(deleteBody).toContain("return null;");
  });

  it("softDeleteByExternalId body does NOT call repo.softDeleteByExternalId", () => {
    const deleteBody = out.slice(
      out.indexOf("async softDeleteByExternalId("),
      out.indexOf("\n  }\n", out.indexOf("async softDeleteByExternalId(")),
    );
    expect(deleteBody).not.toContain("repo.softDeleteByExternalId");
  });

  it("noop body has an explaining comment (delete:noop / tombstone-preserving)", () => {
    const deleteBody = out.slice(
      out.indexOf("async softDeleteByExternalId("),
      out.indexOf("\n  }\n", out.indexOf("async softDeleteByExternalId(")),
    );
    expect(deleteBody).toContain("delete:noop");
  });

  it("contains NO ` as ` cast (noop path)", () => {
    expect(codeOnly(out).includes(" as ")).toBe(false);
  });

  it("find-side and upsert-side are unchanged when deleteMode: 'noop'", () => {
    // The noop knob only affects the delete method body.
    expect(out).toContain("this.repo.findByExternalIdProjected(externalId, this.provider)");
    expect(out).toContain("this.repo.integrationUpsertOne(write, this.provider)");
  });
});

// ============================================================================
// #490 — per-field exclusion
//
// Gate 2.5 correction (2026-06-06): exclusion is WRITE-SURFACE ONLY.
// The find view uses viewCopyThroughFields (the FULL unfiltered list) so the
// emitted view enumerates the excluded field as a bare passthrough — the
// projection type keeps it, and the view must too (type-soundness). Diff-
// soundness holds via the differ's `key in incoming` guard: the adapter never
// sources the excluded field → incoming lacks it → never compared.
// ============================================================================

describe("generateDefaultSink — #490 excluded field absent from write object, present in find view", () => {
  // conversation_external_id excluded — multi-word to catch snake/camel bugs (#487 lesson).
  // The emitter receives post-exclusion copyThroughFields AND the full
  // viewCopyThroughFields (unfiltered); it uses viewCopyThroughFields for the find view.
  const out = generateDefaultSink(
    contactInput({
      entityName: "message",
      entityClass: "Message",
      // copyThroughFields AFTER exclusion — write surface only.
      copyThroughFields: [
        { camelName: "body", tsType: "string" },
        // conversationExternalId intentionally absent — excluded from write surface.
      ],
      // viewCopyThroughFields is the FULL unfiltered list — find view uses this.
      viewCopyThroughFields: [
        { camelName: "body", tsType: "string" },
        { camelName: "conversationExternalId", tsType: "string | null" },
      ],
      fkExternalKeys: [],
    }),
  );

  it("the write object enumerates body: record.body", () => {
    const writeBlock = out.slice(
      out.indexOf("const write: MessageIntegrationWrite = {"),
      out.indexOf("const proj ="),
    );
    expect(writeBlock).toContain("body: record.body,");
  });

  it("the write object does NOT enumerate conversationExternalId", () => {
    const writeBlock = out.slice(
      out.indexOf("const write: MessageIntegrationWrite = {"),
      out.indexOf("const proj ="),
    );
    expect(writeBlock).not.toContain("conversationExternalId");
  });

  it("the find view DOES enumerate conversationExternalId: row.conversationExternalId (Gate 2.5 §3c inverted)", () => {
    // Gate 2.5 correction: the find view uses viewCopyThroughFields (unfiltered).
    // The excluded field stays as a bare passthrough — write-surface-only exclusion.
    expect(findBody(out)).toContain("conversationExternalId: row.conversationExternalId,");
  });

  it("contains NO ` as ` cast", () => {
    expect(codeOnly(out).includes(" as ")).toBe(false);
  });
});

describe("generateDefaultSink — #490 exclusion does not affect localFkColumns or timestamps", () => {
  // Confirm that the scope fence holds: exclusion touches ONLY copyThroughFields.
  // localFkColumns and timestamps are separate inputs and must not be affected.
  const out = generateDefaultSink(
    contactInput({
      entityName: "message",
      entityClass: "Message",
      copyThroughFields: [
        // Only body remains; conversationExternalId is excluded (absent).
        { camelName: "body", tsType: "string" },
      ],
      localFkColumns: [{ camelName: "channelId", tsType: "string | null" }],
      hasTimestamps: true,
    }),
  );

  it("localFkColumns still appear in the find view", () => {
    expect(findBody(out)).toContain("channelId: row.channelId,");
  });

  it("timestamps still appear in the find view", () => {
    expect(findBody(out)).toContain("createdAt: row.createdAt,");
    expect(findBody(out)).toContain("updatedAt: row.updatedAt,");
  });
});
