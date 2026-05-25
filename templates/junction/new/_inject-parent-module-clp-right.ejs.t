---
to: "<%= architecture === 'clean-lite-ps' && exposeOnParent.right ? parentModulePathRight : '' %>"
inject: true
after: "    DatabaseModule,"
skip_if: "<%= classNames.module %>"
---
    // CGP-60 — junction module (forwardRef breaks the parent↔junction module cycle)
    forwardRef(() => <%= classNames.module %>),
