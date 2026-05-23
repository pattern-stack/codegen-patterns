---
to: "<%= architecture === 'clean-lite-ps' && exposeOnParent.left ? parentServicePathLeft : '' %>"
inject: true
after: "from '@nestjs/common';"
skip_if: "from '<%= rightEntityImportFromJunction %>'"
---
import type { <%= rightEntityPascal %> } from '<%= rightEntityImportFromJunction %>';
