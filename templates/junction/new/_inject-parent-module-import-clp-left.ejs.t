---
to: "<%= architecture === 'clean-lite-ps' && exposeOnParent.left ? parentModulePathLeft : '' %>"
inject: true
after: "from '@nestjs/common';"
skip_if: "<%= classNames.module %> }"
---
// CGP-60 — junction module wiring
import { forwardRef } from '@nestjs/common';
import { <%= classNames.module %> } from '<%= junctionModuleImportFromLeft %>';
