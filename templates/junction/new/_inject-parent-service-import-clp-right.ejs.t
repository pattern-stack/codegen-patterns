---
to: "<%= architecture === 'clean-lite-ps' && exposeOnParent.right ? parentServicePathRight : '' %>"
inject: true
after: "from '@nestjs/common';"
skip_if: "<%= classNames.service %> }"
---
// CGP-60 — junction service + types (forwardRef resolves circular module dep)
import { forwardRef } from '@nestjs/common';
import { <%= classNames.service %>, <%= entityNamePascal %>LinkInput } from '<%= junctionServiceImportFromRight %>';
import type { <%= entityNamePascal %> } from '../<%= entityNamePlural %>/<%= name %>.entity';
import type { <%= leftEntityPascal %> } from '<%= leftEntityImportFromJunction %>';
