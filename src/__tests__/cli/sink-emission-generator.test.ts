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
  const out = generateDefaultSink(
    contactInput({
      fkExternalKeys: [{ writeKey: "accountExternalId" }],
    }),
  );

  it("emits the FK external join-key as an active copy-through (no TODO)", () => {
    expect(out).toContain("accountExternalId: record.accountExternalId,");
  });

  it("has no TODO(author) text anywhere", () => {
    expect(out).not.toContain("TODO(author)");
  });

  it("the write block contains an uncommented accountExternalId: assignment", () => {
    const writeBlock = out.slice(
      out.indexOf("const write: ContactIntegrationWrite = {"),
      out.indexOf("const proj ="),
    );
    expect(writeBlock).toMatch(/^\s*accountExternalId:/m);
  });

  it("contains NO ` as ` cast", () => {
    expect(codeOnly(out).includes(" as ")).toBe(false);
  });
});

describe("generateDefaultSink — belongs_to FK entity (multi-word non-self, snake-retained)", () => {
  // sales_account target → sales_accountExternalId (wart mirrored from template;
  // normalization deferred to follow-up #494 per spec Judgment call).
  const out = generateDefaultSink(
    contactInput({
      fkExternalKeys: [{ writeKey: "sales_accountExternalId" }],
    }),
  );

  it("emits the FK key verbatim with snake retained", () => {
    expect(out).toContain(
      "sales_accountExternalId: record.sales_accountExternalId,",
    );
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
  const out = generateDefaultSink(
    contactInput({
      entityName: "account",
      entityClass: "Account",
      fkExternalKeys: [{ writeKey: "parentAccountExternalId" }],
    }),
  );

  it("emits the self-FK key as a camelCase active copy-through", () => {
    expect(out).toContain(
      "parentAccountExternalId: record.parentAccountExternalId,",
    );
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

  it("emits the FK external key as an active copy-through", () => {
    expect(out).toContain("channelExternalId: record.channelExternalId,");
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
});
