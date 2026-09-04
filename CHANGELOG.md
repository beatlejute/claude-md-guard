# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.0] — 2026-09-04

### Changed

- Reverts 0.10.0: layer 1 injects on every session start again, not only
  after a compaction. Skipping the duplicate saved context, but the copy
  Claude Code loads itself is the caveated one, and a rule delivered that way
  is the first to be discounted — drift showed up in practice within two
  weeks. `injectOn: ["compact"]` restores the narrow behaviour.

## [0.10.0] — 2026-08-21

### Changed

- Layer 1 now injects only after a compaction. On startup, resume, `/clear`
  and fork Claude Code loads CLAUDE.md itself, so a second copy just occupied
  context window — for a 12 KB rule file that is a few thousand tokens carried
  for the whole session, twice. Compaction is the case the plugin was built
  for: the original load may not survive it, and then there is nothing to
  re-read from. Add the other sources back through `injectOn` if you want the
  uncaveated framing from the first turn.

## [0.9.1] — 2026-08-15

### Fixed

- A large injection could reach Claude Code truncated, or not at all. The
  hook wrote its reply with `process.stdout.write` and then called
  `process.exit(0)`; stdout is a pipe there, pipes are asynchronous on macOS,
  and an unflushed write is discarded at exit. Short replies survived, a 9 KB
  rule injection came out cut mid-string. Replies are now written with
  `writeSync` in a loop, which is synchronous everywhere and handles partial
  writes.

## [0.9.0] — 2026-08-15

From a third session: 56 shell commands, 23 of them nudged without cause.

### Fixed

- Here-document bodies were parsed as shell. In `python - <<'PY' … PY` every
  line of the Python — `import json`, `except: continue` — read as an
  unrecognized command. The body is now skipped; the opening command is still
  judged on its own.
- Shell block keywords read as command names: `for`, `do`, `done`, `if`,
  `then`. A block header runs nothing, so it is a read; the body arrives as
  its own segment after `do` and is judged there, which is where
  `for f in *.tmp; do rm "$f"; done` is caught.
- `env` was in the read-only list, so `env -u HTTP_PROXY npm run build`
  counted as a read — a missed change, not just noise. `env` and its options
  are now stripped and the real command is judged.
- Added as reads: `printf`, `test`/`[`, `xxd`, `base64`, `date`, `diff`,
  `seq`, `sleep`, `column`, `comm`, `id`, `readlink`, `realpath`, and the
  git subcommands `merge-base`, `cat-file`, `rev-list`, `for-each-ref`,
  `name-rev`, `symbolic-ref`, `count-objects`. `unzip` reads with `-l`/`-p`
  and extracts without. `git worktree list` reads, `add` and `remove` do not.

Across both measured sessions the remaining false nudges are 11 of 56 and 2
of 104, and every one of them is a `python` or `node` invocation, where
treating an interpreter as able to write is the deliberate call.

## [0.8.0] — 2026-08-15

Read from a second real session: 4h43m of work, 104 shell commands, of which
40 drew a nudge they should not have.

### Fixed

- Command splitting ignored quotes, so `grep -E "Error|Timeout|failed"` came
  apart into segments named `Timeout` and `failed`, and every log search read
  as a change to the project. That single bug was most of the 40. The command
  is now split on `|`, `||`, `&&`, `;` and newlines only outside quotes.
- `2>/dev/null` and `2>&1` counted as writing to a file, because any `>` did.
  Redirects are now examined one at a time: a descriptor duplicate or a
  discard is a read, a real path is a change.
- `unset`, `export`, `set`, `read`, `cut`, `tr`, `tasklist`, `wmic` and
  `git fetch` are recognized as reads. `sed` is a read without `-i` and a
  change with it.

With these, the same 104 commands produce 3 false nudges instead of 40, and
all three are `node <script>` invocations, where treating the interpreter as
able to write is the deliberate conservative call.

## [0.7.1] — 2026-08-15

### Fixed

- Restored the rendered checkbox. Dropping the list marker in 0.7.0 also
  dropped the rendering — GFM needs `- [x]` to draw a box, so plain `[x]`
  lines came out as literal brackets. The marker is back; what actually caused
  the nesting was the heading being a list line, so it is now bold text
  followed by a blank line, with the items unindented under it.

## [0.7.0] — 2026-08-15

### Changed

- The checklist drops the markdown list marker: plain `[x] rule` lines under
  the `CLAUDE.md:` heading. The list marker was what nested the block under
  the heading in the first place, and the box already reads as a box without
  it. Duplicate detection accepts a leading bullet anyway, since a model may
  add one out of habit.

## [0.6.1] — 2026-08-15

### Fixed

- The checklist rendered as a bullet with the items nested under it: asking
  for a checklist "headed CLAUDE.md:" led to the heading itself becoming a
  list item. Both layers now say the heading is plain text, never a bullet,
  and the items are unindented and top-level.

## [0.6.0] — 2026-08-15

### Changed

- The compliance report is now a checklist headed `CLAUDE.md:` — `- [x] rule`
  for a rule the turn followed, `- [ ] rule — what and where` for one it
  broke. Shorter than the previous `rule — followed` lines and scannable at a
  glance, with the unchecked boxes standing out as the things to fix.
- Duplicate detection understands both the checklist and the older verdict
  format, and now requires the message to name CLAUDE.md, so an ordinary plan
  written as checkboxes no longer suppresses a check that is genuinely due.

## [0.5.0] — 2026-08-15

Found by reading a real session log: a two-and-a-half hour diagnostic session
where the plugin was active, no file was edited, and it still produced 18
nudges and 14 Stop demands while delivering the rules only in part.

### Fixed

- The character budget did not apply to the most specific file, so a single
  12 KB project CLAUDE.md was injected whole. Claude Code then filed the
  injection away and passed the model a 2 KB preview and a path — the layer
  delivered less than doing nothing would have. That file is now truncated
  on a line boundary with a notice, and the footer names what was cut. Less
  specific files are still dropped whole rather than delivered as fragments.
- The read-only filter knew POSIX commands only, so on Windows it recognized
  nothing: `Get-Content`, `Select-String`, `dir`, `Set-Location`,
  `$c = Get-Content …` and `Remove-Item Env:…` all counted as changes. That
  is what produced the 18 nudges and, through the turn record, the 14 Stop
  demands and their compliance lists. PowerShell cmdlets and aliases are now
  recognized, assignments are unwrapped, and a bare `$c.Length` is a read
  while `$file.Delete()` is not.
- `git -C <path> log` read as the subcommand `<path>` and counted as a change.
  Global git options that take a value are now skipped.

## [0.4.0] — 2026-08-15

### Fixed

- The compliance list was printed twice on turns that changed state: layer 2
  asked for it in the answer, then layer 4 asked again and the model produced
  a second copy. Layer 4 now reads `last_assistant_message` and stays silent
  when a list is already there, which also drops the pointless extra model
  round. Two or more lines ending in a verdict word count as a list; a single
  "followed" in running prose does not.

### Changed

- Both layers now say to leave inapplicable rules out of the list entirely
  rather than listing them as "not applicable" — that was padding the list to
  a dozen lines of noise.

## [0.3.0] — 2026-08-15

### Changed

- The compliance list is now asked for only where there is something to judge:
  a conclusion, an analysis, a recommendation. Status updates,
  acknowledgements and one-line factual replies are exempt. A compliance list
  under "the old monitor expired, no action needed" is noise, and noise is
  what teaches the model to skip the list where it matters.
- The `complianceReport` level formerly called `always` is now `analysis`.
  `always` still works as an alias.

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

[0.11.0]: https://github.com/beatlejute/claude-md-guard/releases/tag/v0.11.0
[0.10.0]: https://github.com/beatlejute/claude-md-guard/releases/tag/v0.10.0
[0.9.1]: https://github.com/beatlejute/claude-md-guard/releases/tag/v0.9.1
[0.9.0]: https://github.com/beatlejute/claude-md-guard/releases/tag/v0.9.0
[0.8.0]: https://github.com/beatlejute/claude-md-guard/releases/tag/v0.8.0
[0.7.1]: https://github.com/beatlejute/claude-md-guard/releases/tag/v0.7.1
[0.7.0]: https://github.com/beatlejute/claude-md-guard/releases/tag/v0.7.0
[0.6.1]: https://github.com/beatlejute/claude-md-guard/releases/tag/v0.6.1
[0.6.0]: https://github.com/beatlejute/claude-md-guard/releases/tag/v0.6.0
[0.5.0]: https://github.com/beatlejute/claude-md-guard/releases/tag/v0.5.0
[0.4.0]: https://github.com/beatlejute/claude-md-guard/releases/tag/v0.4.0
[0.3.0]: https://github.com/beatlejute/claude-md-guard/releases/tag/v0.3.0
[0.2.0]: https://github.com/beatlejute/claude-md-guard/releases/tag/v0.2.0
[0.1.0]: https://github.com/beatlejute/claude-md-guard/releases/tag/v0.1.0
