# Custom OpenPLC dependency

Maintainer editor source HEAD: `882ec0db55120f51fb549a94ebc3541b86886aac`.

editor-working-tree.patch records selected current uncommitted changes only. It is not a complete fork or reproducible r4 distribution, and applicability to an upstream checkout has not been verified.

Candidate rename/import still uses software/openplc-editor-zh/src/cli/commands/agent-candidate.ts, agent-candidate-worker.cjs, local TypeScript, and a legacy r3 executable location. FUXA permission checks also require pinned JSDOM and TypeScript in that source checkout. Missing prerequisites must reject operations; do not bypass the checks.

The native r4 editor additionally contains committed custom CLI functionality. Its complete corresponding source/build instructions must be published separately before claiming a reproducible integrated editor. Upstream executable 4.3.2 alone is insufficient.

This package contains the plugin/controller source and no editor executable, node_modules or third-party scene assets. Compile/run, candidate editing and native permission validation remain dependent on the configured maintainer toolchain.
