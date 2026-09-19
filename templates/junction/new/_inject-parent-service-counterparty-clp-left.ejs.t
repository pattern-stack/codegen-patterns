---
to: "<%= exposeOnParent.left ? parentServicePathLeft : '' %>"
inject: true
after: "from '@nestjs/common';"
skip_if: "from '<%= rightEntityImportFromLeft %>'"
---
import type { <%= rightEntityPascal %> } from '<%= rightEntityImportFromLeft %>';
