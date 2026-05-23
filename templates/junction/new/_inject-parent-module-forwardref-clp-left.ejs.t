---
to: "<%= architecture === 'clean-lite-ps' && exposeOnParent.left ? parentModulePathLeft : '' %>"
inject: true
after: "from '@nestjs/common';"
skip_if: "import { forwardRef"
---
// CGP-60 — forwardRef resolves parent↔junction module cycle
import { forwardRef } from '@nestjs/common';
