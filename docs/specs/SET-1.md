# SET-1: settings, declared once and checked before the build

**Status:** implemented · **Follows:** S-3 · **Brief:** codegen-targets `docs/LANE-provider-settings.md`

## Problem

The values an app needs at startup (a database URL, a provider's OAuth client id and secret, its base URL, the auth
subsystem's encryption key) are named in many places, and nothing lists them:
- the provider YAML names a `client.base_url` but nothing reads it at runtime, and has nowhere to say "this provider
  needs a client id";
- `project init` writes `process.env.DATABASE_URL` into `database.ts`, `drizzle.config.ts` and the Nest database
  module; the auth install appends `INTEGRATION_TOKEN_ENCRYPTION_KEY` and `AUTH_REDIRECT_URI_BASE` lines to
  `.env.config`, and the runtime reads the key by the same literal name;
- under pattern-stack wiring, S-3's provider factory constructs the strategy and client with nothing to pass them.

So a project finds out what it needs one crash at a time.

Doug: *"define a centralized type for this kind of thing … each one base-classed on the same underlying thing, so it's
picked up and we can centrally check for, and suggest, ALL of the values that need to be set, and where, based on what
they've built in the YAML. We can do it pre-build, just from the YAML … Eventually, `.env` support with sops."*

## Decision

### One setting, one derivation

A **setting** is one value the app reads at startup. It is declared once, and every output prints from the
declaration:

| Field | Meaning |
|---|---|
| `group`, `key` | where it sits in the typed settings: `salesforce.clientId` (`settings.salesforce.clientId`) |
| `env` | the environment variable it is read from (`SALESFORCE_CLIENT_ID`) |
| `secret` | masked in every listing; `.env.example` leaves it blank; the later sops step encrypts it |
| `default` | used when unset; a setting with none is **required** |
| `owner` | who needs it: a provider, a subsystem, or the project |
| `source` | the YAML (or the subsystem) that declared it: provenance, as `src/derived/api` carries it |

`src/derived/settings/` (`deriveProjectSettings`) builds the list from the YAML, once. The check command, the
generated `settings.ts`, `.env.example`, the provider factory and the auth install's `.env.config` lines all read
it; none re-lists a name.

**One kind, not two (a change to the brief).** The brief proposed two variants, env vars and config values, on one
base. Both are read from the same place, the environment (a base URL is overridable per environment exactly as a
client id is), and what actually differs is how a value is *handled*: a secret is masked, has no example value, and is
what sops will encrypt; a non-secret may carry a default from the YAML. So a setting has one shape with `secret` and
`default`, and the "variant" is the **source** it is read from: today the environment (and a project's `.env` file,
for the check), later a sops-decrypted file. A second kind with no second source to read from would be an abstraction
over one choice (codegen-targets' rule: an axis gets its abstraction once a second choice exists). The seam for that
second choice is the source, below.

### Declared in the YAML

**Providers.** A provider YAML gains a `settings:` block, keyed by the setting's snake_case name:

```yaml
slug: salesforce
auth: { type: oauth2, strategy: '…#SalesforceOAuthStrategy', scopes: [api] }
client: { class: '…#SalesforceClient', base_url: https://login.salesforce.com }
settings:
  client_id: { secret: true }                       # env SALESFORCE_CLIENT_ID (the default name)
  client_secret: { secret: true }
  instance_url: { env: SF_INSTANCE_URL, default: https://example.my.salesforce.com, description: Your org's URL }
```

- `env` defaults to `<SLUG>_<NAME>` in upper snake case; `secret` to false; no `default` means required. A secret has
  no default in the YAML (a dev value belongs in `.env`); the schema refuses one.
- A `status: planned` provider is a catalog stub: nothing is built from it, so its settings are not listed.
- `client.base_url` is always a setting, `<group>.baseUrl`, env `<SLUG>_BASE_URL`, defaulting to the YAML's value, so
  staging can point elsewhere without a YAML edit. A `settings.base_url` entry overrides it (to rename the env var).
- **Not under `auth:` (a change to the brief).** The brief suggested `auth.client_id: { env: … }`. A provider needs
  settings that aren't auth (an instance URL, a region, a webhook signing secret), and an auth type doesn't fix which
  ones (OAuth needs a client id and secret; an API-key provider's key may be per connection, not per app). One
  `settings:` block holds them all, and `secret:` marks the ones that are credentials. Nothing is implied by
  `auth.type`: a setting exists because the YAML names it.

**Subsystems and the project.** Each declares its settings in one table, `src/derived/settings/subsystems.ts`,
included when it applies:
- the project: `database.url` (`DATABASE_URL`, secret, defaulting to the dev URL `project init` already used);
- auth, when installed: `auth.tokenEncryptionKey` (`INTEGRATION_TOKEN_ENCRYPTION_KEY`, secret, required) and
  `auth.redirectUriBase` (`AUTH_REDIRECT_URI_BASE`, default `http://localhost:3000`). The env names are the runtime's
  own constants (`runtime/subsystems/auth/backends/encryption-key/env.ts` exports the one it reads), and the auth
  install's `.env.config` template prints the names from the table, byte for byte as before;
- events, integration: none today.
Jobs' `REDIS_URL` (Nest, BullMQ) and `LOG_LEVEL` are not in this step; each joins the table when its subsystem moves
to pattern-stack.

Two settings in one group with one key, or a provider whose group is a subsystem's (`database`, `auth`), is refused,
naming both.

### Checked before the build: `codegen project settings`

Works from the YAML alone, under either wiring, with no build:

```
$ codegen project settings
DATABASE_URL              database.url             project              secret   default
SALESFORCE_CLIENT_ID      salesforce.clientId      provider salesforce  secret   MISSING
SALESFORCE_CLIENT_SECRET  salesforce.clientSecret  provider salesforce  secret   set
SALESFORCE_BASE_URL       salesforce.baseUrl       provider salesforce           default (https://login.salesforce.com)
```

- "Set" means set in the environment, or in the project's `.env` or `.env.config` (where the auth install writes its
  key). That is `projectSource(dir)`, the same source the generated `settings` system loads through, so a value the
  check counts is one the app finds, on Node (which loads no `.env` by itself) as on Bun. A secret's value is never
  printed.
- A value (or default) the loader would refuse — a base URL that isn't a URL, an empty value — is `INVALID`, with the
  reason: the check applies `settingValueProblem`, the loader's own rule.
- `--check` exits 1 when a required setting is unset or a value is invalid, naming each one and where to set it.
- `--json` prints the derivation with each status, for Studio.

### Loaded and checked at startup (pattern-stack)

`entity new` (and `project init`, over the empty set) writes `<generated>/settings.ts`:
- `SETTINGS`, the declaration as data; `type Settings`, the typed object (`settings.salesforce.clientId: string`);
- `loadSettings(source?)`: one Zod schema over every setting (a base URL is checked as a URL); on failure it throws
  once, listing every missing or malformed value with its env var;
- `settingsSystem`, the `settings` system: `create` calls `loadSettings()`. It is first in `SYSTEMS`, so a missing
  value fails compose before any other part is created, with the whole list.

The runtime half is `runtime/settings.ts` (Nest-free; the gate's list): the spec types, `loadSettings(spec, source)`,
`SettingsError`, and the sources.

**The database reads it too.** `project init`'s `database.ts` now `uses: ['settings']` and connects to
`settings.database.url` unless `composeApp` was given a URL. An existing project's `database.ts` is the project's and
is left as it is.

### `.env.example`

Written beside `codegen.config.yaml` by the same step, from the same derivation: one block per owner, each line
`ENV=` with a comment saying the key, whether it is secret, and its default. Secrets are blank; a default is shown
commented out (`# SALESFORCE_BASE_URL=https://login.salesforce.com`), so copying the file to `.env` sets only what
must be set. It is @generated: hand edits go in `.env`. A `.env.example` without codegen's banner is the project's, and
is left as it is (with a warning), never replaced.

### The provider factory takes the typed settings

S-3's emit-once `<slug>.provider.factory.ts` now takes the provider's group:

```ts
/** settings: baseUrl, clientId, clientSecret (`codegen project settings` lists them). */
export function createSalesforceProvider(settings: Settings['salesforce']): SalesforceProvider {
  // Pass each constructor what it takes, e.g.
  //   new SalesforceOAuthStrategy({ clientId: settings.clientId, clientSecret: settings.clientSecret })
  return {
    auth: new SalesforceOAuthStrategy(),
    client: new SalesforceClient(),
  };
}
```

and the provider system `uses: ['settings']` and calls it with `settings.<group>`.

**Not prefilled into the calls (a change to the brief).** The brief had the factory call
`new SalesforceOAuthStrategy({ clientId: settings.salesforce.clientId, … })`. That is a constructor rule after all:
a freshly generated project whose strategy takes no argument, or takes them another way, would not compile, and the
factory is the one file meant to absorb that. So the factory receives the typed settings (typed per provider, so a
typo is a compile error), and its comment shows the call with the provider's actual keys. The author writes the
arguments once.

No upgrade path for output an earlier codegen wrote (no backwards compatibility until there are users): a factory
written before this step takes no argument and fails `tsc` against the system that passes one, and the settings loader
reaches a vendored project through `VENDORED_RUNTIME_FILES` (`project init`, `project update`), like every runtime file.

Each setting's owner is named by `settingOwnerLabel`; the client's base URL is `PROVIDER_BASE_URL_KEY`; `.env.example`
is codegen's when `isGeneratedEnvExample`; a provider setting's `default` is one line (the schema refuses a line
break, which would break settings.ts and `.env.example`). `project settings --json` prints its error as JSON.

### The seam for sops

A source is `(setting: { group, key, env }) => string | undefined`: it is asked for the whole reference, so an env
source reads `env` and a committed config file keyed by `group.key` reads that, and a config file is a new source, not
a second kind of setting (the PM, 2026-11-27: what "vars vs config" becomes if Doug wants it). `loadSettings(spec,
source)` reads only through it:
`processEnvSource`, `dotEnvFileSource(path)`, `layered(...sources)` (first defined wins), and `projectSource(dir)` —
the environment, then `<dir>/.env`, then `<dir>/.env.config` — which both the generated loader (in the working
directory) and the check command (in the project) read.

**Next step (not this PR): encrypted, committable secrets.** A `sopsFileSource('secrets/<env>.enc.env')` that decrypts
with `sops -d` (or the sops library) once at startup and serves the values, layered under the environment, so dev and
CI read committed secrets and production can still inject real env vars. The derivation already says which settings
are secret, so `codegen project settings --sops-template` can write the file's skeleton with exactly those keys, and
the check can report a secret that is set in plaintext `.env` but missing from the encrypted file. Which environment
is loaded (`APP_ENV`), key management (age or KMS), and whether the CLI decrypts for the check are that step's spec.

## Not in this step

- sops, encrypted secrets, per-environment files (the seam above).
- Nest output: unchanged. The Nest app keeps reading `process.env` where it does; the check command covers a Nest
  project too (its database and auth settings, and its providers).
- Jobs' and the logger's env vars (above).

## The gate

- `test-smoke-integration --wiring pattern-stack`: the fixture's salesforce YAML declares `client_id` and
  `client_secret`. The smoke runs `codegen project settings --check` (fails, naming both), then with them set
  (passes); runs `main.ts` with them unset (compose fails once, naming both) and set (composes); and asserts
  `.env.example` and `settings.ts` carry them.
- Unit tests: the derivation (providers, `base_url`, the env default, overrides, subsystems, refusals),
  `loadSettings` (every missing value in one error, URL check, defaults, the sources), the check command's rows and
  exit code, the generated `settings.ts` and `.env.example`, the factory and the provider system.
- One test adds a setting to a provider YAML and asserts it appears in the check, `settings.ts` and `.env.example`
  with no other edit.
- The Nest output is held by the baseline, the goldens and every Nest smoke; the auth install's `.env.config` bytes
  by its existing tests.
