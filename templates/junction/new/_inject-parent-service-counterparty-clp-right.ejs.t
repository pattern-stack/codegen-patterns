---
to: "<%= architecture === 'clean-lite-ps' && exposeOnParent.right ? parentServicePathRight : '' %>"
inject: true
after: "from '@nestjs/common';"
skip_if: "from '<%= leftEntityImportFromJunction %>'"
---
import type { <%= leftEntityPascal %> } from '<%= leftEntityImportFromJunction %>';
