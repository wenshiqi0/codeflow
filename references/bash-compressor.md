# Bash compressor

The bash-compressor extension listens to Pi's `tool_result` event after the built-in bash tool has already applied its default 50KB / 2000-line tail truncation.

When the model-visible bash result exceeds `CODEFLOW_BASH_COMPRESS_THRESHOLD_BYTES` (default `16384`), Codeflow invokes the internal `zipper` role with DeepSeek V4 Flash. The zipper has 20 seconds to return a bounded semantic summary. On timeout, provider error, empty output, unsafe control bytes, or a summary no smaller than the original result, Codeflow leaves the original Pi result unchanged.

The compressed result:

- preserves command metadata and error severity;
- prioritizes compiler/linter/runtime diagnostics, failed tests, and final summaries;
- removes progress and successful noise;
- never gets authority to change tool execution or handoff state.

The zipper child runs with no tools, no extensions, no context files, and no session. Its input declares bash output as untrusted data.
