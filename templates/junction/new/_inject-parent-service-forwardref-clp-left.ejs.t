---
to: "<%= architecture === 'clean-lite-ps' && exposeOnParent.left ? parentServicePathLeft : '' %>"
inject: true
after: "from '@nestjs/common';"
skip_if: "import { forwardRef"
---
// CGP-60 — forwardRef resolves circular module dep (junction → parent)
import { forwardRef } from '@nestjs/common';
