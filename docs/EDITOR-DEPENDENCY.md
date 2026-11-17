# OpenPLC shared editor dependency

Public source: https://github.com/HellsegaMIMIC/openplc-editor-dsh at v2026.11.17-preview.1 (6cebf8baa24777f7757a3ba1e63c525fc480e2fe). Place that checkout at software/openplc-editor-zh and follow its dependency/build instructions.

The PLC tool adapter builds scripts/build-agent-tools.cjs using scripts/agent-tools-sources.json and the native source/dependencies. Installing an editor executable alone does not provide this source worker. Legacy candidate paths and FUXA permission checks also use the source checkout, pinned TypeScript and JSDOM. Missing or mismatched prerequisites fail closed.

The public portable editor is an editing preview: it does not bundle the complete compiler/Runtime toolchain. OpenPLC Runtime and MSYS remain separate dependencies. This source release does not claim a clean-machine integrated installation or native Runtime acceptance.
