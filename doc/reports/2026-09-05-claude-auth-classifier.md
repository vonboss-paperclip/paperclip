# Claude login classification from diagnostic channels

A source comment such as `// espace (public, not logged in) -> Espace client`
inside a JSONL tool result previously caused `claude_auth_required`, even when
the final event had `subtype: success` and `is_error: false`.

`detectClaudeLoginRequired` searched the complete serialized stdout/stderr.
Both result-mapping paths in `execute` give this classification precedence over
other errors. Consequently, unrelated tool output could also replace a max-turns
failure or mislabel process termination after a successful terminal result.

The detector now gives a successful terminal priority, searches only designated
error fields in structured events, and keeps an anchored plain-text fallback for
CLI startup/login diagnostics. Assistant prose and user/tool payloads are not
searched. Login URL discovery remains available to the explicit login command.
The `/login` and invalid-key-with-login-prompt markers already used by the runtime
are also retained on this older fork baseline.

## Verification

Run the focused fork tests from the repository root:

```sh
pnpm exec vitest run --config vitest.config.ts --root packages/adapters/claude-local \
  src/server/login-required.test.ts src/server/parse.test.ts
```

On 2026-09-05 this passed 29 tests (20 new provenance cases, 9 existing parser
cases). Dependencies were resolved from the installed runtime packages; a clean
fork dependency install and the repository-wide build/test/typecheck were not run.

The separately captured deployed-source validation passed 65 tests: 39 existing
parser cases, the same 20 provenance cases, and 6 tests exercising the real
`execute` result mapping with mocked process output. Against the unmodified
runtime, 8 provenance cases and 3 execute cases failed. After the patch, both
parsed and fallback mappings preserve terminal cleanup evidence, real auth
failures still classify as auth, and max-turns/timeout precedence is preserved.
Two existing adapter-utils tests also passed while actually stopping lingering
processes after terminal output.

## Integration boundary

This fork's baseline is `b7545823bec49b4a73c3813d8fb634f68fc84b48` (2026-05-26).
It differs from the deployed source: in particular, the old execute implementation
has not yet gained the runtime's successful-terminal precedence and cleanup
metadata propagation. This PR changes only the classifier and its tests; the
runtime-specific execute regression tests and source-hashed patch are supplied
as review artifacts with the task. Do not treat this fork as a deployment branch.

The upstream classifier has also evolved independently (token-failure detection
was added while broad legacy login matching remained). A maintainer porting this
fix should preserve that newer token-failure handling rather than replacing the
upstream detector wholesale.

This is a proposed correction, not a deployment. No process cleanup implementation,
agent invocation/pause guard, credentials, or agent configuration is changed.
The classification defect alone does not establish why any agent was paused.

## Limits

Plain-text fallback output has no trustworthy event envelope. Matching a CLI
prompt at the beginning of a line is a conservative compatibility fallback, not
proof of provenance for arbitrary unframed text. Future CLI wording changes may
require additional explicit diagnostic cases. Structured provider failures are
recognized through failure flags/subtypes, error events, or the CLI assistant
`authentication_failed` marker; ordinary terminal summaries are not diagnostics.
