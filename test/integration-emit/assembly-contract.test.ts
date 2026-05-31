/**
 * Integration assembly **emission contract** suite (RFC-0002 §8, Track D · E4).
 *
 * The sibling `snapshot.test.ts` locks the emitted bytes for the checked-in
 * single-provider / FK-free fixture. Bytes alone don't give signal (memory
 * `feedback_smoke_filter_signal` / the project's testing philosophy): a snapshot
 * tells you *something changed*, not *whether the contract still holds*. This
 * suite drives `emitAdapters` (the same entry point `cdp gen` invokes) over
 * **synthetic in-test inputs** and asserts the STRUCTURAL INVARIANTS of the
 * emission with explicit `expect`s — the assembly wiring shape, the sink
 * delegation/seam, the token + aggregator contract, the `pattern: Integrated`
 * gate, and the §7q3 two-provider-no-collision claim.
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
 * (`emitAdapters` → `buildSinkInput` → `generateDefaultSink` /
 * `generateAssemblyModule` / `generateIntegrationAggregator`) end-to-end. The
 * shared snapshot is intentionally left unchanged (zero diff).
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  emitAdapters,
  type EmitAdaptersEntity,
} from "../../src/cli/shared/adapter-emission-generator";
import { generateDefaultSink } from "../../src/cli/shared/sink-emission-generator";
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

  test("binds INTEGRATION_CHANGE_SOURCE via adapter.changeSources['<entity>'] with inject:[<Adapter>] (Option A)", () => {
    expect(mod).toContain("provide: INTEGRATION_CHANGE_SOURCE,");
    expect(mod).toContain(
      "useFactory: (adapter: SalesforceCrmAdapter) => adapter.changeSources['account'],",
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
// 2. Sink scaffold contract — FK (belongs_to) + user_id, through emitAdapters
// ============================================================================

describe("E4 · sink scaffold contract — FK belongs_to + user_id (contact via emitAdapters)", () => {
  const { read, result } = run({ providers: [SALESFORCE], entities: [CONTACT] });
  const sink = read("crm/sinks/contact.sink.ts");

  test("carries the <CODEGEN-SCAFFOLD-V1> sentinel as the first line (emit-once)", () => {
    expect(sink.split("\n")[0]).toBe("// <CODEGEN-SCAFFOLD-V1>");
    expect(result.scaffoldsWritten.some((p) => p.endsWith("contact.sink.ts"))).toBe(true);
  });

  test("provider-match throw guards upsertByExternalId", () => {
    expect(sink).toContain("if (provider !== this.provider) {");
    expect(sink).toContain(
      "throw new Error(`ContactSink: bound provider '${this.provider}' != run provider '${provider}'`);",
    );
  });

  test("delegates to findByExternalIdProjected / integrationUpsertOne / softDeleteByExternalId", () => {
    expect(sink).toContain("this.repo.findByExternalIdProjected(externalId, this.provider)");
    expect(sink).toContain("this.repo.integrationUpsertOne(write, this.provider)");
    expect(sink).toContain("this.repo.softDeleteByExternalId(externalId, this.provider)");
  });

  test("emits the FK external-key seam as a commented TODO(author) line for the belongs_to", () => {
    // The orchestration path (buildSinkInput) derives `accountExternalId` from
    // the belongs_to(account); the seam stays COMMENTED so the write compiles.
    expect(sink).toContain(
      "// accountExternalId: /* TODO(author): external id of the related account */ null,",
    );
  });

  test("emits a bare `userId,` ONLY because user_id is declared (sourced from the param)", () => {
    expect(sink).toContain("      userId,");
    // user_id must NOT also appear as a record copy-through line.
    expect(sink).not.toContain("userId: record.userId");
  });

  test("copies the non-FK, non-userId scalar (email) through from the record", () => {
    expect(sink).toContain("email: record.email,");
    // the FK column itself (account_id) is NOT a copy-through field.
    expect(sink).not.toContain("accountId: record.accountId");
  });

  test("contains NO ` as ` cast anywhere", () => {
    expect(codeOnly(sink)).not.toMatch(/\bas\b\s+[A-Za-z{]/);
  });
});

describe("E4 · sink scaffold — FK-free, no user_id emits no seam and no userId", () => {
  const { read } = run({ providers: [SALESFORCE], entities: [ACCOUNT] });
  const sink = read("crm/sinks/account.sink.ts");

  test("no FK TODO seam", () => {
    expect(sink).not.toContain("TODO(author)");
  });

  test("no bare userId in the write (account declares no user_id)", () => {
    expect(sink).not.toContain("      userId,");
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
    // no sink + no assembly for reminder; account still emitted.
    expect(result.scaffoldsWritten.some((p) => p.endsWith("reminder.sink.ts"))).toBe(false);
    expect(result.assembliesWritten.some((p) => p.includes("reminder-integration"))).toBe(false);
    expect(result.assembliesWritten.some((p) => p.includes("account-integration"))).toBe(true);
    void outRoot;
  });

  test("generateDefaultSink hard-errors if called directly on a non-Integrated input", () => {
    expect(() =>
      generateDefaultSink({
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
