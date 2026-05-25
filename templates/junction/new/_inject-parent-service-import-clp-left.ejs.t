---
to: "<%= architecture === 'clean-lite-ps' && exposeOnParent.left ? parentServicePathLeft : '' %>"
inject: true
after: "from '@nestjs/common';"
skip_if: "<%= classNames.service %> }"
---
// CGP-60 — junction service + types
import { <%= classNames.service %>, <%= entityNamePascal %>LinkInput } from '<%= junctionServiceImportFromLeft %>';
import type { <%= entityNamePascal %> } from '../<%= entityNamePlural %>/<%= name %>.entity';
