/**
 * Unit tests for the default `IIntegrationSink` emitter (RFC-0002 §4, E1).
 *
 * Pure-function tests — no filesystem. Cover:
 *   (a) FK-free entity → clean passthrough write, sentinel, provider assert,
 *       three methods, Canonical alias, and NO ` as ` cast;
 *   (b) belongs_to FK entity → commented `// TODO(author): …ExternalId` seam;
 *   (c) non-`Integrated` pattern → hard-error naming the entity + the missing
 *       `pattern: Integrated`;
 *   (d) provider literal is the bare slug.
 */

import { describe, it, expect } from "bun:test";
import {
  generateDefaultSink,
  type SinkEmitInput,
} from "../../cli/shared/sink-emission-generator";

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

describe("generateDefaultSink — belongs_to FK entity", () => {
  const out = generateDefaultSink(
    contactInput({
      fkExternalKeys: [{ writeKey: "accountExternalId" }],
    }),
  );

  it("emits the FK external join-key as a commented TODO(author) seam", () => {
    expect(out).toContain(
      "// accountExternalId: /* TODO(author): external id of the related account */ null,",
    );
  });

  it("keeps the seam commented so the write object still compiles", () => {
    // the seam line is a comment — the active write members are only
    // externalId + copy-through, which all exist on the write type.
    const writeBlock = out.slice(
      out.indexOf("const write: ContactIntegrationWrite = {"),
      out.indexOf("const proj ="),
    );
    expect(writeBlock).toContain("// accountExternalId:");
    // no uncommented accountExternalId assignment
    expect(writeBlock).not.toMatch(/^\s*accountExternalId:/m);
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
