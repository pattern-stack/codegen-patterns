/**
 * Integration assembly **emission contract** suite (RFC-0002 §8, Track D · E4).
 *
 * #491 update: the sink is now a TWO-FILE SEAM (@generated base + emit-once subclass).
 *   - `<entity>.sink.generated.ts` → base with standalone default functions + abstract
 *     SinkBase<TCanonical>. Goes onto `result.written` (the @generated bucket).
 *   - `<entity>.sink.ts` → emit-once subclass with two one-line seam wirings.
 *     Goes onto `result.scaffoldsWritten` / `result.scaffoldsSkipped`.
 *   - No CODEGEN-SCAFFOLD-V1 sentinel on any sink file (deleted for the sink;
 *     ADAPTER sentinel is a separate concern and is untouched).
 *   - Binding still valid: assembly module imports `<E>Sink` from `../../sinks/<entity>.sink`.
 *
 * The sibling `snapshot.test.ts` locks the emitted bytes for the checked-in
 * single-provider / FK-free fixture. Bytes alone don't give signal (memory
 * `feedback_smoke_filter_signal` / the project's testing philosophy): a snapshot
 * tells you *something changed*, not *whether the contract still holds*. This
 * suite drives `emitAdapters` (the same entry point `cdp gen` invokes) over
 * **synthetic in-test inputs** and asserts the STRUCTURAL INVARIANTS of the
 * emission with explicit `expect`s — the assembly wiring shape, the sink two-file
 * seam, the token + aggregator contract, the `pattern: Integrated` gate, and the
 * §7q3 two-provider-no-collision claim.
 *
 * ## Why synthetic inputs, not a shared-fixture extension (E4 decision)
 *
 * Two cases the snapshot fixture deliberately does NOT carry — an FK
 * (`belongs_to`) relation, and a second provider on one surface — are exercised
 * here as synthetic `EmitAdaptersEntity` / provider inputs rather than by
 * mutating `test/fixtures/integration-patterns/`. The shared snapshot is a
 * reviewed artifact (`_emit.ts` header); adding FK + a second crm provider would
 * ripple both it AND the RFC-0001 read-side (a second provider re-shapes the
 * crm barrel/aggregator/typed-view) confusingly, while teaching the *contract*
 * nothing the explicit `expect`s here don't. The emitters are pure structured-
 * input string-builders, so synthetic inputs drive the exact orchestration path
 * (`emitAdapters` → `buildSinkInput` → `generateSinkBase` / `generateSinkSubclass` /
 * `generateAssemblyModule` / `generateIntegrationAggregator`) end-to-end. The
 * shared snapshot is intentionally left unchanged (zero diff).
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  emitAdapters,
  type EmitAdaptersEntity,
} from "../../src/cli/shared/adapter-emission-generator";
import { generateSinkBase } from "../../src/cli/shared/sink-emission-generator";
import type { LoadedProvider } from "../../src/parser/validate-providers";
import type { ProviderDefinition } from "../../src/schema/provider-definition.schema";

// ============================================================================
// Synthetic inputs — a fully-specified provider + a representative entity set
// covering: scalar-only (account), userId-declared (contact), and FK belongs_to
// (contact → account). A second crm provider (hubspot) exercises multi-provider.
// ============================================================================

function provider(slug: string, surfaces: string[]): LoadedProvider {
  const definition: ProviderDefinition = {
    slug,
    display_name: slug.charAt(0).toUpperCase() + slug.slice(1),
    auth: {
      type: "oauth2",
      strategy: `@app/integrations/providers/${slug}/${slug}-oauth.strategy#${slug}OAuthStrategy`,
      scopes: ["api"],
    },
    client: {
      class: `@app/integrations/providers/${slug}/${slug}.client#${slug}Client`,
      base_url: "https://example.com",
    },
    surfaces,
  } as ProviderDefinition;
  return { definition, filePath: `/defs/providers/${slug}.yaml` } as LoadedProvider;
}

const SALESFORCE = provider("salesforce", ["crm"]);
const HUBSPOT = provider("hubspot", ["crm"]);

/** account — scalar-only, no FK, no user_id. */
const ACCOUNT: EmitAdaptersEntity = {
  entity: { name: "account", surface: "crm", pattern: "Integrated", plural: "accounts" },
  fields: { name: { type: "string" } },
};

/** contact — declares user_id (copy-through, but sourced from the param) AND a
 *  belongs_to(account) FK. The single richest entity for the sink contract. */
const CONTACT: EmitAdaptersEntity = {
  entity: { name: "contact", surface: "crm", pattern: "Integrated", plural: "contacts" },
  fields: {
    email: { type: "string" },
    user_id: { type: "uuid" },
  },
  relationships: {
    account: { type: "belongs_to", target: "account", foreign_key: "account_id" },
  },
};

/** reminder — a crm surface entity WITHOUT pattern: Integrated → skipped. */
const REMINDER: EmitAdaptersEntity = {
  entity: { name: "reminder", surface: "crm", plural: "reminders" },
};

const BACKEND_SRC = "/proj/src";
const ALIASES = { "@modules": "/proj/src/modules" };

/** Strip whole-line `//` comments so a no-cast / no-import assertion isn't
 *  tripped by English prose ("the same seam as ...") or doc references to a
 *  module name (e.g. "not CrmAdaptersModule") in a banner/doc comment. The
 *  emitters never trail an inline `// ...` on a code line, so this is exact. */
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
    .join("\n");
}

function run(opts: {
  providers: LoadedProvider[];
  entities: EmitAdaptersEntity[];
}) {
  const outRoot = mkdtempSync(join(tmpdir(), "cgp-e4-"));
  const result = emitAdapters({
    providers: opts.providers,
    entities: opts.entities,
    outputRoot: outRoot,
    backendSrcAbs: BACKEND_SRC,
    aliases: ALIASES,
  });
  const read = (rel: string) => readFileSync(join(outRoot, rel), "utf-8");
  return { outRoot, result, read };
}

// ============================================================================
// 1. Assembly module contract (single provider)
// ============================================================================

describe("E4 · assembly module contract — emitAdapters(crm/account ← salesforce)", () => {
  const { read } = run({ providers: [SALESFORCE], entities: [ACCOUNT] });
  const mod = read("crm/modules/salesforce/account-integration.module.ts");

  test("class name is <Entity>IntegrationModule__<Provider>", () => {
    expect(mod).toContain("export class AccountIntegrationModule__Salesforce {}");
  });

  test("imports [<Entity>Module, <Provider><Surface>AdapterModule] and NOTHING else", () => {
    expect(mod).toContain("imports: [AccountsModule, SalesforceCrmAdapterModule],");
    // §7q3 / Option A: must NOT import any Interaction/RawLanding module, nor the
    // collision-fold surface aggregator.
    expect(mod).not.toContain("RawLanding");
    expect(mod).not.toContain("Interaction");
    expect(mod).not.toContain("CrmAdaptersModule");
  });

  test("binds INTEGRATION_CHANGE_SOURCE via adapter.changeSources.<entity> with inject:[<Adapter>] (Option A)", () => {
    expect(mod).toContain("provide: INTEGRATION_CHANGE_SOURCE,");
    // biome-clean literal member access (entity names are snake_case identifiers).
    expect(mod).toContain(
      "useFactory: (adapter: SalesforceCrmAdapter) => adapter.changeSources.account,",
    );
    expect(mod).toContain("inject: [SalesforceCrmAdapter],");
  });

  test("binds INTEGRATION_SINK via new <Entity>Sink(repo, '<provider-slug>')", () => {
    expect(mod).toContain("provide: INTEGRATION_SINK,");
    expect(mod).toContain(
      "useFactory: (repo: AccountRepository) => new AccountSink(repo, 'salesforce'),",
    );
    expect(mod).toContain("inject: [AccountRepository],");
  });

  test("provides a bare ExecuteIntegrationUseCase, aliases it under the unique token via useExisting, exports that token", () => {
    expect(mod).toContain("ExecuteIntegrationUseCase,");
    expect(mod).toContain(
      "{ provide: ACCOUNT_INTEGRATION_USE_CASE__SALESFORCE, useExisting: ExecuteIntegrationUseCase },",
    );
    expect(mod).toContain("exports: [ACCOUNT_INTEGRATION_USE_CASE__SALESFORCE],");
  });

  test("contains NO ` as ` cast (standing no-type-loosening rule)", () => {
    expect(codeOnly(mod)).not.toMatch(/\bas\b\s+[A-Za-z{]/);
  });
});

// ============================================================================
// 2. Sink two-file seam contract (#491) — FK (belongs_to) + user_id, through emitAdapters
// ============================================================================

describe("E4 · sink two-file seam — both files emitted, correct buckets (contact via emitAdapters)", () => {
  const { read, result } = run({ providers: [SALESFORCE], entities: [CONTACT] });

  test("base file (*.sink.generated.ts) is on result.written (the @generated bucket)", () => {
    expect(result.written.some((p) => p.endsWith("contact.sink.generated.ts"))).toBe(true);
  });

  test("subclass file (*.sink.ts) is on result.scaffoldsWritten (emit-once bucket)", () => {
    expect(result.scaffoldsWritten.some((p) => p.endsWith("contact.sink.ts"))).toBe(true);
  });

  test("subclass is NOT on result.written (it is emit-once, not @generated)", () => {
    expect(result.written.some((p) => p.endsWith("contact.sink.ts"))).toBe(false);
  });
});

describe("E4 · sink base file (@generated) assertions — FK belongs_to + user_id (contact)", () => {
  const { read } = run({ providers: [SALESFORCE], entities: [CONTACT] });
  const base = read("crm/sinks/contact.sink.generated.ts");

  test("carries @generated banner (NOT the CODEGEN-SCAFFOLD-V1 sentinel)", () => {
    expect(base).toContain("@generated by @pattern-stack/codegen");
    expect(base).not.toContain("<CODEGEN-SCAFFOLD-V1>");
  });

  test("emits defaultContactBuildWrite + defaultContactToCanonicalView standalone functions", () => {
    expect(base).toContain(
      "export function defaultContactBuildWrite(record: ContactIntegrationProjection): ContactIntegrationWrite {",
    );
    expect(base).toContain(
      "export function defaultContactToCanonicalView(row: ContactIntegrationProjection): ContactIntegrationProjection {",
    );
  });

  test("emits abstract class ContactSinkBase<TCanonical = ContactIntegrationProjection>", () => {
    expect(base).toContain(
      "export abstract class ContactSinkBase<TCanonical = ContactIntegrationProjection>",
    );
  });

  test("NO @Injectable decorator in code on the base (OQ2 CLOSED — factory binding)", () => {
    // The comment mentions @Injectable() to explain why it is absent — that is intentional.
    // Assert no active @Injectable() decorator call in code lines.
    expect(codeOnly(base)).not.toContain("@Injectable");
  });

  test("NO extends bound on TCanonical", () => {
    expect(base).not.toMatch(/TCanonical extends/);
  });

  test("provider-match throw guards upsertByExternalId on the base", () => {
    expect(base).toContain("if (provider !== this.provider) {");
    expect(base).toContain(
      "throw new Error(`ContactSink: bound provider '${this.provider}' != run provider '${provider}'`);",
    );
  });

  test("delegates to findByExternalIdProjected / integrationUpsertOne / softDeleteByExternalId in base concrete methods", () => {
    expect(base).toContain("this.repo.findByExternalIdProjected(externalId, this.provider)");
    expect(base).toContain("this.repo.integrationUpsertOne(this.buildWrite(record), this.provider)");
    expect(base).toContain("this.repo.softDeleteByExternalId(externalId, this.provider)");
  });

  test("FK external-key is null + SEAM comment in defaultContactBuildWrite (projection-default canonical has no external-key member)", () => {
    expect(base).toContain("accountExternalId: null,");
    expect(base).toContain("SEAM (FK external key");
    expect(codeOnly(base)).not.toContain("accountExternalId: record.");
    expect(base).not.toContain("TODO(author)");
  });

  test("bare `userId,` ONLY in defaultContactBuildWrite because user_id is declared", () => {
    const buildWriteFn = base.slice(
      base.indexOf("export function defaultContactBuildWrite("),
      base.indexOf("export function defaultContactToCanonicalView("),
    );
    expect(buildWriteFn).toContain("userId,");
    expect(buildWriteFn).not.toContain("userId: record.userId");
  });

  test("copies the non-FK, non-userId scalar (email) through in defaultContactBuildWrite", () => {
    expect(base).toContain("email: record.email,");
    expect(base).not.toContain("accountId: record.accountId");
  });

  test("two abstract seams declared on the base (NO body)", () => {
    expect(base).toContain(
      "protected abstract toCanonicalView(row: ContactIntegrationProjection): TCanonical;",
    );
    expect(base).toContain(
      "protected abstract buildWrite(record: TCanonical): ContactIntegrationWrite;",
    );
  });

  test("contains NO ` as ` cast anywhere", () => {
    expect(codeOnly(base)).not.toMatch(/\bas\b\s+[A-Za-z{]/);
  });
});

describe("E4 · sink subclass file (emit-once) assertions — FK belongs_to + user_id (contact)", () => {
  const { read } = run({ providers: [SALESFORCE], entities: [CONTACT] });
  const sub = read("crm/sinks/contact.sink.ts");

  test("class ContactSink extends ContactSinkBase", () => {
    expect(sub).toContain("export class ContactSink extends ContactSinkBase {");
  });

  test("carries the two one-line seam wirings (NOT an empty body)", () => {
    expect(sub).toContain("return defaultContactToCanonicalView(row);");
    expect(sub).toContain("return defaultContactBuildWrite(record);");
  });

  test("imports ContactSinkBase + default functions from ./contact.sink.generated", () => {
    expect(sub).toContain("from './contact.sink.generated'");
    expect(sub).toContain("ContactSinkBase,");
    expect(sub).toContain("defaultContactToCanonicalView,");
    expect(sub).toContain("defaultContactBuildWrite,");
  });

  test("does NOT carry CODEGEN-SCAFFOLD-V1 sentinel", () => {
    expect(sub).not.toContain("<CODEGEN-SCAFFOLD-V1>");
  });

  test("does NOT carry machinery (integrationUpsertOne / findByExternalIdProjected)", () => {
    expect(sub).not.toContain("integrationUpsertOne");
    expect(sub).not.toContain("findByExternalIdProjected");
  });

  test("contains NO ` as ` cast", () => {
    expect(codeOnly(sub)).not.toMatch(/\bas\b\s+[A-Za-z{]/);
  });
});

describe("E4 · sink FK-free, no user_id — account entity", () => {
  const { read } = run({ providers: [SALESFORCE], entities: [ACCOUNT] });
  const base = read("crm/sinks/account.sink.generated.ts");
  const sub = read("crm/sinks/account.sink.ts");

  test("base: no FK TODO seam, no userId", () => {
    expect(base).not.toContain("TODO(author)");
    const buildWriteFn = base.slice(
      base.indexOf("export function defaultAccountBuildWrite("),
      base.indexOf("export function defaultAccountToCanonicalView("),
    );
    expect(buildWriteFn).not.toContain("userId,");
  });

  test("subclass: class AccountSink extends AccountSinkBase", () => {
    expect(sub).toContain("export class AccountSink extends AccountSinkBase {");
  });
});

describe("E4 · sink sentinel scope — ADAPTER sentinel KEPT, SINK sentinel DELETED (#491)", () => {
  const { read } = run({ providers: [SALESFORCE], entities: [ACCOUNT] });

  test("the adapter scaffold STILL carries CODEGEN-SCAFFOLD-V1 (adapter sentinel is a separate concern, kept)", () => {
    const adapter = read("crm/adapters/salesforce/salesforce-crm.adapter.ts");
    expect(adapter).toContain("<CODEGEN-SCAFFOLD-V1>");
  });

  test("NO *.sink.* file carries CODEGEN-SCAFFOLD-V1 (sink sentinel deleted)", () => {
    const base = read("crm/sinks/account.sink.generated.ts");
    const sub = read("crm/sinks/account.sink.ts");
    expect(base).not.toContain("<CODEGEN-SCAFFOLD-V1>");
    expect(sub).not.toContain("<CODEGEN-SCAFFOLD-V1>");
  });
});

describe("E4 · regen semantics — base regenerates, subclass is existsSync-skipped", () => {
  // Emit once into a tmpdir, hand-edit the subclass, emit again — assert (a) base
  // is regenerated (would reflect YAML changes) and (b) subclass is skipped.
  test("second emit: base is regenerated, subclass is skipped (not overwritten)", () => {
    const outRoot = mkdtempSync(join(tmpdir(), "cgp-e4-regen-"));
    const MARKER = "// HAND_EDIT_MARKER_12345";

    // First emit.
    emitAdapters({
      providers: [SALESFORCE],
      entities: [ACCOUNT],
      outputRoot: outRoot,
      backendSrcAbs: BACKEND_SRC,
      aliases: ALIASES,
    });

    const subclassPath = join(outRoot, "crm/sinks/account.sink.ts");
    expect(existsSync(subclassPath)).toBe(true);
    // Hand-edit the subclass.
    const originalSubclass = readFileSync(subclassPath, "utf-8");
    writeFileSync(subclassPath, `${MARKER}\n${originalSubclass}`);

    // Second emit.
    const result2 = emitAdapters({
      providers: [SALESFORCE],
      entities: [ACCOUNT],
      outputRoot: outRoot,
      backendSrcAbs: BACKEND_SRC,
      aliases: ALIASES,
    });

    // (a) Base is regenerated — on result2.written.
    expect(result2.written.some((p) => p.endsWith("account.sink.generated.ts"))).toBe(true);
    // (b) Subclass is skipped — on result2.scaffoldsSkipped, NOT scaffoldsWritten.
    expect(result2.scaffoldsSkipped.some((p) => p.endsWith("account.sink.ts"))).toBe(true);
    expect(result2.scaffoldsWritten.some((p) => p.endsWith("account.sink.ts"))).toBe(false);
    // (c) Hand edit survives.
    const afterSubclass = readFileSync(subclassPath, "utf-8");
    expect(afterSubclass).toContain(MARKER);
  });
});

describe("E4 · generateSinkBase hard-errors if called directly on a non-Integrated input", () => {
  test("throws naming pattern: Integrated", () => {
    expect(() =>
      generateSinkBase({
        entityName: "reminder",
        entityClass: "Reminder",
        surface: "crm",
        pattern: "Activity",
        provider: "salesforce",
        copyThroughFields: [],
        fkExternalKeys: [],
        repoImportSpecifier: "@modules/reminders/reminder.repository",
      }),
    ).toThrow(/pattern: Integrated/);
  });
});

// ============================================================================
// 3. Tokens file contract
// ============================================================================

describe("E4 · tokens file contract", () => {
  const { read } = run({ providers: [SALESFORCE], entities: [ACCOUNT, CONTACT] });
  const tokens = read("crm/crm-integration.tokens.ts");

  test("one Symbol.for(...) per (entity, provider) with the screaming-snake const name", () => {
    expect(tokens).toContain(
      "export const ACCOUNT_INTEGRATION_USE_CASE__SALESFORCE = Symbol.for('@app/integrations/crm.account-integration-use-case.salesforce');",
    );
    expect(tokens).toContain(
      "export const CONTACT_INTEGRATION_USE_CASE__SALESFORCE = Symbol.for('@app/integrations/crm.contact-integration-use-case.salesforce');",
    );
  });
});

// ============================================================================
// 4. Aggregator contract + §7q3 Option-A invariant
// ============================================================================

describe("E4 · surface integration aggregator contract (single provider)", () => {
  const { read } = run({ providers: [SALESFORCE], entities: [ACCOUNT, CONTACT] });
  const agg = read("crm/crm-integration.module.ts");

  test("class name is <Surface>IntegrationModule", () => {
    expect(agg).toContain("export class CrmIntegrationModule {}");
  });

  test("imports AND exports every per-entity assembly module (deterministic order)", () => {
    for (const cls of [
      "AccountIntegrationModule__Salesforce",
      "ContactIntegrationModule__Salesforce",
    ]) {
      expect(agg).toContain(`import { ${cls} }`);
      expect(agg).toContain(cls);
    }
    // imports list and exports list both name every module.
    const importsLine = agg.match(/imports: \[([^\]]*)\]/)?.[1] ?? "";
    const exportsLine = agg.match(/exports: \[([^\]]*)\]/)?.[1] ?? "";
    expect(importsLine).toContain("AccountIntegrationModule__Salesforce");
    expect(importsLine).toContain("ContactIntegrationModule__Salesforce");
    expect(exportsLine).toContain("AccountIntegrationModule__Salesforce");
    expect(exportsLine).toContain("ContactIntegrationModule__Salesforce");
  });

  test("§7q3 / Option A: the aggregator does NOT import <Surface>AdaptersModule (the collision fold)", () => {
    // The name appears once in the doc comment ("not CrmAdaptersModule") — that
    // is intentional. What must be absent is any actual import/reference in code.
    expect(codeOnly(agg)).not.toContain("CrmAdaptersModule");
    expect(agg).not.toContain("./crm-adapters.module");
    expect(agg).not.toContain("ENTITY_SOURCES");
  });
});

// ============================================================================
// 5. pattern: Integrated gate
// ============================================================================

describe("E4 · pattern: Integrated gate", () => {
  test("a surface entity WITHOUT pattern: Integrated is skipped-with-reason and emits no sink/assembly", () => {
    const { result, outRoot } = run({
      providers: [SALESFORCE],
      entities: [ACCOUNT, REMINDER],
    });
    // skip recorded with a reason naming the missing pattern.
    const skip = result.skippedAssemblies.find((s) => s.entity === "reminder");
    expect(skip).toBeDefined();
    expect(skip?.surface).toBe("crm");
    expect(skip?.reason).toContain("not 'pattern: Integrated'");
    // no sink (neither base nor subclass) + no assembly for reminder; account still emitted.
    expect(result.written.some((p) => p.endsWith("reminder.sink.generated.ts"))).toBe(false);
    expect(result.scaffoldsWritten.some((p) => p.endsWith("reminder.sink.ts"))).toBe(false);
    expect(result.assembliesWritten.some((p) => p.includes("reminder-integration"))).toBe(false);
    expect(result.assembliesWritten.some((p) => p.includes("account-integration"))).toBe(true);
    void outRoot;
  });

  test("generateSinkBase hard-errors if called directly on a non-Integrated input (see also the explicit test above)", () => {
    // Covered by the explicit describe above — preserved here for the E4 suite
    // pattern:Integrated gate story.
    expect(() =>
      generateSinkBase({
        entityName: "reminder",
        entityClass: "Reminder",
        surface: "crm",
        pattern: "Activity",
        provider: "salesforce",
        copyThroughFields: [],
        fkExternalKeys: [],
        repoImportSpecifier: "@modules/reminders/reminder.repository",
      }),
    ).toThrow(/pattern: Integrated/);
  });
});

// ============================================================================
// 6. Multi-provider on one surface — §7q3 two-provider-no-collision, executable
// ============================================================================

// ============================================================================
// 7. YAML knob coverage through emitAdapters (#490 — delete:noop + exclude_fields)
// ============================================================================

/** thread — carries both YAML knobs:
 *   integration.sink.delete: noop         → softDeleteByExternalId body is a no-op return null
 *   integration.sink.exclude_fields: [conversation_external_id]
 *                                          → write surface omits the field; find view retains it */
const THREAD: EmitAdaptersEntity = {
  entity: { name: "thread", surface: "crm", pattern: "Integrated", plural: "threads" },
  fields: {
    subject: { type: "string" },
    conversation_external_id: { type: "string", nullable: true },
  },
  integration: {
    sink: {
      delete: "noop",
      exclude_fields: ["conversation_external_id"],
    },
  },
};

describe("E4 · sink knobs through emitAdapters — delete:noop + exclude_fields (#490 in the generated base)", () => {
  const { read } = run({ providers: [SALESFORCE], entities: [THREAD] });
  const base = read("crm/sinks/thread.sink.generated.ts");

  test("delete:noop emits a logged no-op body in softDeleteByExternalId (no repo delete delegation)", () => {
    // The body must contain the noop marker and return null; must NOT delegate to repo.
    expect(base).toContain("delete:noop (YAML integration.sink.delete: noop)");
    expect(base).toContain("return null;");
    // The delegate path must be absent.
    const deleteMethodStart = base.indexOf("async softDeleteByExternalId(");
    const deleteMethodEnd = base.indexOf("\n  }", deleteMethodStart);
    const deleteBody = base.slice(deleteMethodStart, deleteMethodEnd);
    expect(deleteBody).not.toContain("this.repo.softDeleteByExternalId");
  });

  test("exclude_fields omits the excluded field from the write mapping (copy-through write surface)", () => {
    // defaultThreadBuildWrite must NOT contain conversationExternalId: record.conversationExternalId.
    const buildWriteStart = base.indexOf("export function defaultThreadBuildWrite(");
    const buildWriteEnd = base.indexOf("\nexport function defaultThread", buildWriteStart + 1);
    const buildWriteFn = base.slice(buildWriteStart, buildWriteEnd);
    expect(buildWriteFn).not.toContain("conversationExternalId");
  });

  test("excluded field IS retained in the find-side view (write-surface-only exclusion per #490 Gate 2.5)", () => {
    // defaultThreadToCanonicalView must enumerate conversationExternalId as a passthrough.
    const viewStart = base.indexOf("export function defaultThreadToCanonicalView(");
    const viewEnd = base.indexOf("\n// Abstract base", viewStart);
    const viewFn = base.slice(viewStart, viewEnd);
    expect(viewFn).toContain("conversationExternalId: row.conversationExternalId,");
  });

  test("contains NO ` as ` cast anywhere (standing no-type-loosening rule)", () => {
    expect(codeOnly(base)).not.toMatch(/\bas\b\s+[A-Za-z{]/);
  });
});

describe("E4 · multi-provider on one surface (salesforce + hubspot serve crm)", () => {
  const { read, result } = run({
    providers: [SALESFORCE, HUBSPOT],
    entities: [ACCOUNT],
  });

  test("emits TWO assembly modules for the one entity — one per provider", () => {
    const sf = read("crm/modules/salesforce/account-integration.module.ts");
    const hs = read("crm/modules/hubspot/account-integration.module.ts");
    expect(sf).toContain("export class AccountIntegrationModule__Salesforce {}");
    expect(hs).toContain("export class AccountIntegrationModule__Hubspot {}");
    // each binds its own provider literal in the sink factory.
    expect(sf).toContain("new AccountSink(repo, 'salesforce')");
    expect(hs).toContain("new AccountSink(repo, 'hubspot')");
  });

  test("emits TWO tokens for the entity — one per provider", () => {
    const tokens = read("crm/crm-integration.tokens.ts");
    expect(tokens).toContain("export const ACCOUNT_INTEGRATION_USE_CASE__SALESFORCE = Symbol.for(");
    expect(tokens).toContain("export const ACCOUNT_INTEGRATION_USE_CASE__HUBSPOT = Symbol.for(");
  });

  test("the integration aggregator imports BOTH per-provider assembly modules", () => {
    const agg = read("crm/crm-integration.module.ts");
    expect(agg).toContain("import { AccountIntegrationModule__Hubspot }");
    expect(agg).toContain("import { AccountIntegrationModule__Salesforce }");
    const importsLine = agg.match(/imports: \[([^\]]*)\]/)?.[1] ?? "";
    expect(importsLine).toContain("AccountIntegrationModule__Hubspot");
    expect(importsLine).toContain("AccountIntegrationModule__Salesforce");
  });

  test("§7q3 EXECUTABLE: the run path (aggregator) does NOT pull in CrmAdaptersModule — the Gong two-provider case does NOT hit the throw-on-collision fold", () => {
    const agg = read("crm/crm-integration.module.ts");
    // The collision fold lives ONLY in <Surface>AdaptersModule. The integration
    // aggregator — AppModule's entry point — must not reference it, so two
    // providers serving one entity is purely incremental (two assemblies), never
    // a boot collision. This makes the RFC §7q3 / Gong-incremental claim
    // executably asserted, not just prose.
    expect(codeOnly(agg)).not.toContain("CrmAdaptersModule");
    expect(agg).not.toContain("./crm-adapters.module");
    expect(agg).not.toContain("ambiguous change source");
    expect(agg).not.toContain("ENTITY_SOURCES");
  });

  test("the throw-on-collision fold is confined to the separate <Surface>AdaptersModule (read-side aggregator), not the integration run path", () => {
    // Sanity: the collision logic DOES still exist on the read side (we are not
    // deleting it — it guards the entity-keyed registry consumers like CrmPort);
    // it is simply off the integration run path. Assert it lives where expected.
    const readSideAgg = read("crm/crm-adapters.module.ts");
    expect(readSideAgg).toContain("ambiguous change source");
    expect(readSideAgg).toContain("export class CrmAdaptersModule {}");
    // and it is a DIFFERENT file from the integration aggregator.
    expect(result.integrationAggregatorsWritten.some((p) => p.endsWith("crm-integration.module.ts"))).toBe(true);
  });
});
