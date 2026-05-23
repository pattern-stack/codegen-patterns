---
to: "<%= architecture === 'clean-lite-ps' && exposeOnParent.right ? parentServicePathRight : '' %>"
inject: true
after: "from '@nestjs/common';"
skip_if: "<%= classNames.service %> }"
---
// CGP-60 — junction service + types
import { <%= classNames.service %>, <%= entityNamePascal %>LinkInput } from '<%= junctionServiceImportFromRight %>';
import type { <%= entityNamePascal %> } from '../<%= entityNamePlural %>/<%= name %>.entity';
