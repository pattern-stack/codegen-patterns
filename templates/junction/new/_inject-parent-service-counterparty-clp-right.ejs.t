---
to: "<%= exposeOnParent.right ? parentServicePathRight : '' %>"
inject: true
after: "from '@nestjs/common';"
skip_if: "from '<%= leftEntityImportFromRight %>'"
---
import type { <%= leftEntityPascal %> } from '<%= leftEntityImportFromRight %>';
