---
to: "<%= generate.electricMigrations ? `packages/db/src/server/migrations/${table}-electric.sql` : '' %>"
force: false
---
ALTER TABLE <%= table %> REPLICA IDENTITY FULL;
ALTER PUBLICATION electric_publication_default ADD TABLE <%= table %>;
