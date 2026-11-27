CREATE TABLE IF NOT EXISTS "accounts" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  CONSTRAINT "accounts_name_len" CHECK (length(name) <= 255)
);
CREATE TABLE IF NOT EXISTS "catalog_entries" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "sku" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "price_cents" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "deleted_at" TEXT,
  CONSTRAINT "catalog_entries_sku_len" CHECK (length(sku) <= 64)
);
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_entries_tenant_id_sku_uniq" ON "catalog_entries" (ifnull("tenant_id", X'00'), ifnull("sku", X'00'));
CREATE INDEX IF NOT EXISTS "catalog_entries_tenant_id_idx" ON "catalog_entries" ("tenant_id");
CREATE TABLE IF NOT EXISTS "communications" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "occurred_at" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "external_id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT "communications_id_kind_uniq" UNIQUE ("id", "kind"),
  CONSTRAINT "communications_id_tenant_id_uniq" UNIQUE ("id", "tenant_id"),
  CONSTRAINT "communications_kind_in" CHECK (kind IN ('meeting', 'email', 'message')),
  CONSTRAINT "communications_source_len" CHECK (length(source) <= 32)
);
CREATE UNIQUE INDEX IF NOT EXISTS "communications_tenant_id_source_external_id_uniq" ON "communications" (ifnull("tenant_id", X'00'), ifnull("source", X'00'), ifnull("external_id", X'00'));
CREATE INDEX IF NOT EXISTS "communications_tenant_id_idx" ON "communications" ("tenant_id");
CREATE TABLE IF NOT EXISTS "tenants" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  CONSTRAINT "tenants_name_len" CHECK (length(name) <= 255)
);
CREATE TABLE IF NOT EXISTS "persons" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL REFERENCES "tenants"("id"),
  "email" TEXT NOT NULL,
  "first_name" TEXT NOT NULL,
  "last_name" TEXT NOT NULL,
  "nicknames" TEXT,
  "preferred_channels" TEXT NOT NULL DEFAULT 'undefined',
  CONSTRAINT "persons_email_len" CHECK (length(email) <= 255),
  CONSTRAINT "persons_first_name_len" CHECK (length(first_name) <= 100),
  CONSTRAINT "persons_last_name_len" CHECK (length(last_name) <= 100),
  CONSTRAINT "persons_preferred_channels_in" CHECK (preferred_channels IN ('email', 'phone', 'sms'))
);
CREATE INDEX IF NOT EXISTS "persons_tenant_id_idx" ON "persons" ("tenant_id");
CREATE INDEX IF NOT EXISTS "persons_email_idx" ON "persons" ("email");
CREATE TABLE IF NOT EXISTS "users" (
  "id" TEXT PRIMARY KEY,
  "person_id" TEXT REFERENCES "persons"("id") ON DELETE RESTRICT,
  "tenant_id" TEXT NOT NULL REFERENCES "tenants"("id"),
  "email" TEXT NOT NULL,
  CONSTRAINT "users_email_len" CHECK (length(email) <= 255)
);
CREATE INDEX IF NOT EXISTS "users_tenant_id_idx" ON "users" ("tenant_id");
CREATE INDEX IF NOT EXISTS "users_email_idx" ON "users" ("email");
CREATE TABLE IF NOT EXISTS "contacts" (
  "id" TEXT PRIMARY KEY,
  "account_id" TEXT REFERENCES "accounts"("id") ON DELETE RESTRICT,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "first_name" TEXT NOT NULL,
  "last_name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "title" TEXT,
  "phone" TEXT,
  "linkedin_url" TEXT,
  "external_id" TEXT,
  "provider" TEXT,
  "provider_metadata" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "deleted_at" TEXT,
  CONSTRAINT "contacts_first_name_len" CHECK (length(first_name) <= 100),
  CONSTRAINT "contacts_last_name_len" CHECK (length(last_name) <= 100),
  CONSTRAINT "contacts_email_len" CHECK (length(email) <= 255),
  CONSTRAINT "contacts_title_len" CHECK (length(title) <= 200),
  CONSTRAINT "contacts_phone_len" CHECK (length(phone) <= 50),
  CONSTRAINT "contacts_linkedin_url_len" CHECK (length(linkedin_url) <= 500)
);
CREATE INDEX IF NOT EXISTS "contacts_account_id_idx" ON "contacts" ("account_id");
CREATE INDEX IF NOT EXISTS "contacts_user_id_idx" ON "contacts" ("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_contacts_provider_external_id" ON "contacts" ("provider", "external_id");
CREATE TABLE IF NOT EXISTS "deal_states" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT REFERENCES "tenants"("id"),
  "name" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "state_type" TEXT NOT NULL,
  "sort_order" TEXT NOT NULL,
  "probability_default" TEXT,
  "color" TEXT,
  "weight" TEXT NOT NULL DEFAULT 'undefined',
  "description" TEXT,
  "metadata" TEXT,
  CONSTRAINT "deal_states_name_len" CHECK (length(name) <= 50),
  CONSTRAINT "deal_states_display_name_len" CHECK (length(display_name) <= 100),
  CONSTRAINT "deal_states_state_type_in" CHECK (state_type IN ('open', 'won', 'lost', 'stalled')),
  CONSTRAINT "deal_states_color_len" CHECK (length(color) <= 20)
);
CREATE INDEX IF NOT EXISTS "deal_states_tenant_id_idx" ON "deal_states" ("tenant_id");
CREATE TABLE IF NOT EXISTS "deals" (
  "id" TEXT PRIMARY KEY,
  "owner_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "closed_by_id" TEXT REFERENCES "users"("id") ON DELETE RESTRICT,
  "account_id" TEXT NOT NULL REFERENCES "accounts"("id") ON DELETE RESTRICT,
  "name" TEXT NOT NULL,
  "amount" TEXT,
  "stage" TEXT NOT NULL,
  "close_date" TEXT,
  "probability" TEXT,
  "external_id" TEXT,
  "provider" TEXT,
  "provider_metadata" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "deleted_at" TEXT,
  CONSTRAINT "deals_name_len" CHECK (length(name) <= 255),
  CONSTRAINT "deals_stage_in" CHECK (stage IN ('prospecting', 'qualification', 'proposal', 'negotiation', 'closed_won', 'closed_lost'))
);
CREATE INDEX IF NOT EXISTS "deals_owner_id_idx" ON "deals" ("owner_id");
CREATE INDEX IF NOT EXISTS "deals_account_id_idx" ON "deals" ("account_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_deals_provider_external_id" ON "deals" ("provider", "external_id");
CREATE TABLE IF NOT EXISTS "email_threads" (
  "id" TEXT PRIMARY KEY,
  "topic" TEXT
);
CREATE TABLE IF NOT EXISTS "emails" (
  "id" TEXT PRIMARY KEY,
  "kind" TEXT NOT NULL DEFAULT 'email',
  "tenant_id" TEXT NOT NULL,
  "thread_id" TEXT REFERENCES "email_threads"("id") ON DELETE RESTRICT,
  "subject" TEXT NOT NULL,
  CONSTRAINT "emails_communication_kind_fk" FOREIGN KEY ("id", "kind") REFERENCES "communications"("id", "kind") ON DELETE CASCADE,
  CONSTRAINT "emails_communication_tenant_fk" FOREIGN KEY ("id", "tenant_id") REFERENCES "communications"("id", "tenant_id") ON DELETE CASCADE,
  CONSTRAINT "emails_kind_check" CHECK (kind = 'email')
);
CREATE INDEX IF NOT EXISTS "emails_tenant_id_idx" ON "emails" ("tenant_id");
CREATE TABLE IF NOT EXISTS "meetings" (
  "id" TEXT PRIMARY KEY,
  "kind" TEXT NOT NULL DEFAULT 'meeting',
  "tenant_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "starts_at" TEXT NOT NULL,
  "ends_at" TEXT,
  "link" TEXT,
  CONSTRAINT "meetings_communication_kind_fk" FOREIGN KEY ("id", "kind") REFERENCES "communications"("id", "kind") ON DELETE CASCADE,
  CONSTRAINT "meetings_communication_tenant_fk" FOREIGN KEY ("id", "tenant_id") REFERENCES "communications"("id", "tenant_id") ON DELETE CASCADE,
  CONSTRAINT "meetings_kind_check" CHECK (kind = 'meeting')
);
CREATE INDEX IF NOT EXISTS "meetings_tenant_id_idx" ON "meetings" ("tenant_id");
CREATE TABLE IF NOT EXISTS "meeting_transcripts" (
  "id" TEXT PRIMARY KEY,
  "meeting_id" TEXT NOT NULL REFERENCES "meetings"("id") ON DELETE CASCADE,
  "language" TEXT
);
CREATE TABLE IF NOT EXISTS "organizations" (
  "id" TEXT PRIMARY KEY,
  "parent_id" TEXT REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "tenant_id" TEXT NOT NULL REFERENCES "tenants"("id"),
  "name" TEXT NOT NULL,
  "domain" TEXT,
  CONSTRAINT "organizations_name_len" CHECK (length(name) <= 255),
  CONSTRAINT "organizations_domain_len" CHECK (length(domain) <= 255)
);
CREATE INDEX IF NOT EXISTS "organizations_tenant_id_idx" ON "organizations" ("tenant_id");
CREATE INDEX IF NOT EXISTS "organizations_domain_idx" ON "organizations" ("domain");
CREATE INDEX IF NOT EXISTS "organizations_parent_id_idx" ON "organizations" ("parent_id");
CREATE TABLE IF NOT EXISTS "opportunities" (
  "id" TEXT PRIMARY KEY,
  "organization_id" TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "owner_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "state_id" TEXT NOT NULL REFERENCES "deal_states"("id") ON DELETE RESTRICT,
  "tenant_id" TEXT NOT NULL REFERENCES "tenants"("id"),
  "name" TEXT NOT NULL,
  "amount" TEXT,
  "currency" TEXT DEFAULT 'undefined',
  "expected_close_date" TEXT,
  "closed_at" TEXT,
  CONSTRAINT "opportunities_name_len" CHECK (length(name) <= 255),
  CONSTRAINT "opportunities_currency_len" CHECK (length(currency) <= 3)
);
CREATE INDEX IF NOT EXISTS "opportunities_tenant_id_idx" ON "opportunities" ("tenant_id");
CREATE INDEX IF NOT EXISTS "opportunities_organization_id_idx" ON "opportunities" ("organization_id");
CREATE INDEX IF NOT EXISTS "opportunities_owner_id_idx" ON "opportunities" ("owner_id");
CREATE INDEX IF NOT EXISTS "opportunities_state_id_idx" ON "opportunities" ("state_id");
