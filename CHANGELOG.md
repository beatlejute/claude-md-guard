# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-08-15

### Added

- `complianceReport` setting. Layers 2 and 4 now ask for the verdict to appear
  in the answer — one line per applicable CLAUDE.md rule, each marked followed
  or violated — instead of only asking the model to verify. A request to
  "check yourself" can be satisfied silently; naming each rule and its verdict
  cannot. Set it to `changes` to demand the list only on turns that changed
  state, or `off` for the previous wording.

## [0.1.0] — 2026-08-14

First release. Four hook layers, no dependencies.

### Added

- `SessionStart` re-injection of the CLAUDE.md files in force, mirroring how
  Claude Code discovers them: managed policy, user scope, `.claude/rules/`
  (path-scoped rules excluded), and the project tree from the root down to the
  working directory, with `@` imports expanded and block HTML comments stripped.
- `UserPromptSubmit` one-line request to verify against the rules before acting.
- `PostToolUse` nudge tied to the specific file or command, with rotating
  wording and a cooldown, plus the per-turn change record.
- `Stop` self-check that lists what the turn changed and asks for a pass over it
  against the rules. Skipped on conversational turns and when
  `stop_hook_active` is set.
- Configuration through `~/.claude/claude-md-guard.json`,
  `<project>/.claude/claude-md-guard.json` and `CLAUDE_MD_GUARD_*` environment
  variables, including full overrides for the text sent to the model.
- 20 tests covering the library functions and the hook scripts end to end.

[0.2.0]: https://github.com/beatlejute/claude-md-guard/releases/tag/v0.2.0
[0.1.0]: https://github.com/beatlejute/claude-md-guard/releases/tag/v0.1.0
