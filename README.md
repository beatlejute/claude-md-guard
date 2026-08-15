# claude-md-guard

[![test](https://github.com/beatlejute/claude-md-guard/actions/workflows/test.yml/badge.svg)](https://github.com/beatlejute/claude-md-guard/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Claude Code plugin that keeps CLAUDE.md in the agent's field of view: it
re-reads the rules after a context compaction and does not let a turn that
touched files finish without checking itself against them.

The problem it solves: CLAUDE.md content reaches the model as an ordinary user
message wrapped in the caveat *"this context may or may not be relevant to your
task"*. After a compaction it may not survive at all. Hooks, by contrast, put
the text into context as a plain `system-reminder` — no caveat, and freshly on
every session.

## How it works

Four layers, cheapest first:

| Layer | Event | What it does | Cost |
| :---- | :---- | :----------- | :--- |
| 1. Re-injection | `SessionStart` | Puts the full text of the CLAUDE.md files in force into context — on startup, on `--resume`, after `/clear`, after a compaction, and in a fork | size of the rules, once per session |
| 2. Reminder | `UserPromptSubmit` | Asks the model to check itself against the rules before acting, and to show the verdict rule by rule whenever it concludes, analyses or recommends | ~90 tokens per prompt |
| 3. Nudge | `PostToolUse` | After `Edit`/`Write`/`MultiEdit`/`NotebookEdit`/`Bash` — "you just changed `<file>`, check it against CLAUDE.md". The wording rotates so the model does not tune it out | ~35 tokens, at most once per 45 s |
| 4. Self-check | `Stop` | If the turn changed anything, lists what changed and asks for a rule-by-rule compliance list before finishing | ~80 tokens plus one extra model round |

Layers 2 and 4 do not stop at "verify against the rules" — that request is
easy to satisfy by thinking about it silently and moving on. They ask for the
verdict to appear in the answer as a checklist:

```
**CLAUDE.md**

- [x] Always answer in Russian
- [ ] Use markdown links for file references — plain backticks in the summary above
```

The exact shape is load-bearing. `- [x]` is what renders as a real checkbox,
and the blank line after a bold heading is what keeps the items from nesting
underneath it as a sub-list.

Naming each rule and its verdict is what makes a skipped rule visible. Only
rules that actually bear on the turn belong in the list — a rule that does not
apply is left out, not listed as "not applicable".

The checklist is printed once. Layer 4 reads `last_assistant_message`, and if
the answer already carries one it stays silent instead of asking for a second,
which also saves the extra model round. An ordinary plan written as checkboxes
does not count — the message has to name CLAUDE.md for it to read as a
compliance checklist.

The list is asked for where there is something to judge — a conclusion, an
analysis, a recommendation. Status updates, acknowledgements and one-line
factual replies are exempt on purpose: a compliance list under "the old monitor
expired, no action needed" is noise, and noise is what teaches the model to
skip the list where it matters. Set `complianceReport` to `changes` to narrow
it further, to turns that actually changed something, or to `off` for the plain
"check yourself" wording.

Layer 1 mirrors how Claude Code itself loads memory: it walks the tree from the
root down to the working directory, collects `CLAUDE.md`, `CLAUDE.local.md`,
`.claude/CLAUDE.md`, `.claude/rules/*.md` (path-scoped rules excluded) and the
machine-wide managed-policy file, expands `@` imports (up to 4 hops, skipping
code) and strips block HTML comments.

Layer 4 stays quiet on conversational turns: if nothing changed, `Stop` returns
nothing. Otherwise every reply would be forced through a second round. Loop
protection is twofold — the `stop_hook_active` input field, and clearing the
turn record before replying.

Layer 3 ignores reads: `git status`, `ls`, `rg`, `cat` and the like do not count
as changes, including under an `rtk` or `sudo` wrapper. PowerShell is covered
too — `Get-Content`, `Select-String`, `dir`, `Set-Location`, a captured
`$c = Get-Content …`, and `Remove-Item Env:…` all read rather than change.
`ForEach-Object` and `Invoke-*` are deliberately left out: their script blocks
can do anything, and a false nudge is cheaper than a missed change.

The command is parsed with quotes respected, so the alternation in
`grep -E "Error|Timeout|failed"` stays inside its argument instead of being
read as three more commands. Here-document bodies are skipped — the Python
inside `python - <<'PY' … PY` is not shell. Block keywords are understood:
`for f in *.log; do grep x "$f"; done` reads, the same loop around `rm` does
not. `env -u HTTP_PROXY npm run build` is judged as `npm run build` rather
than as `env`. `2>/dev/null` and `2>&1` discard output rather than write a
file; a redirect to a real path does count as a change.

What deliberately stays on the cautious side: `python`, `node` and other
interpreters count as changes whatever their arguments say, because a script
can write anything. In two measured sessions that is the only remaining source
of false nudges.

If a CLAUDE.md is large enough to be truncated, the better fix is on your side:
Claude Code's own guidance is to keep each file under 200 lines, and
[path-scoped rules](https://code.claude.com/docs/en/memory) in `.claude/rules/`
load only when Claude touches matching files.

## Install

The repository is both a plugin and a marketplace, so one line registers it:

```
/plugin marketplace add beatlejute/claude-md-guard
/plugin install claude-md-guard@claude-md-guard
```

From a local clone:

```
/plugin marketplace add /path/to/claude-md-guard
/plugin install claude-md-guard@claude-md-guard
```

For development, link the directory in place so edits apply without a
reinstall. Any folder holding a `.claude-plugin/plugin.json` under
`~/.claude/skills/` loads as a plugin on the next session:

```powershell
# a junction, unlike a symlink, needs no administrator rights
New-Item -ItemType Junction -Path "$HOME\.claude\skills\claude-md-guard" -Target "C:\path\to\claude-md-guard"
```

```bash
ln -s /path/to/claude-md-guard ~/.claude/skills/claude-md-guard
```

Requires Node.js ≥ 18 on `PATH` — hooks run as `node <script>.mjs`. The plugin
itself has no dependencies.

## Configuration

Nothing needs configuring. If you want to, values are read in ascending order
of precedence from `~/.claude/claude-md-guard.json`,
`<project>/.claude/claude-md-guard.json`, and `CLAUDE_MD_GUARD_*` environment
variables (the key in SCREAMING_SNAKE_CASE).

| Key | Default | Meaning |
| :-- | :------ | :------ |
| `injectOn` | `startup, resume, clear, compact, fork` | Which SessionStart sources trigger injection. Narrow it to `compact, clear` if you would rather not duplicate the built-in load |
| `maxChars` | `9000` | Character budget for the injection. Above 10000 Claude Code writes the text to a file and passes the model a preview instead, so the budget stays under it: the most specific file is truncated with a notice if it alone exceeds the budget, and less specific files are dropped whole rather than delivered as fragments |
| `nudgeCooldownSec` | `45` | Minimum interval between layer-3 nudges |
| `nudgeOnNewFile` | `false` | Nudge on every new file regardless of the interval |
| `stopMode` | `feedback` | `feedback` — soft form (`additionalContext`, shown as "Stop hook feedback"); `block` — hard form (`decision: block`, flagged as a hook error); `off` — disable layer 4 |
| `complianceReport` | `analysis` | Where to demand an explicit rule-by-rule list: `analysis` — whenever the answer concludes, analyses or recommends, and again before finishing a changing turn; `changes` — only before finishing a turn that changed state; `off` — never. `always` is accepted as an alias for `analysis` |
| `promptReminder` | `true` | Layer 2 |
| `skipReadOnlyBash` | `true` | Do not nudge after read-only commands |
| `includeRules` | `true` | Include `.claude/rules/*.md` |
| `includeLocal` | `true` | Include `CLAUDE.local.md` |
| `includeManaged` | `true` | Include the machine-wide managed-policy CLAUDE.md |
| `importDepth` | `4` | How deep `@` imports are expanded |
| `messages` | `{}` | Override the text sent to the model: keys `sessionHeader`, `sessionFooter`, `promptReminder`, `nudge`, `stop` |

Example — re-injection after compaction only, no nudges, no Stop layer:

```json
{
  "injectOn": ["compact", "clear"],
  "promptReminder": false,
  "stopMode": "off"
}
```

Example — keep the compliance list, but only where a turn actually changed
something, so ordinary answers stay clean:

```json
{
  "complianceReport": "changes"
}
```

Debugging: `CLAUDE_MD_GUARD_DEBUG=1` prints hook stack traces to stderr. To
confirm an injection arrived, run `claude --debug` and read the hook log.

## An honest limitation

This is a self-check, not a barrier. All four layers work through context: they
make the rules harder to miss and ask for verification, but nothing stops the
model from doing otherwise. Machine-checkable prohibitions — "never touch
`dist/`", "never run `rm -rf`" — belong in `permissions.deny` instead, where the
client enforces them rather than the model.

A second limitation: the text of layers 2–4 is phrased as a request for action
("check this against CLAUDE.md") rather than as a statement of fact. The Claude
Code documentation recommends writing `additionalContext` as factual
statements — text that reads like an out-of-band system command can trip the
model's prompt-injection defenses and get surfaced to the user instead of
becoming context. What is used here is an imperative that does not imitate a
system channel. If you ever see the model repeating a nudge back at you instead
of acting on it, that is the symptom; rephrase through `messages`.

## Development

```bash
npm test    # node --test, 20 tests, no dependencies
```

The tests run the hook scripts themselves, feeding stdin the same JSON Claude
Code sends, with `HOME` and `CLAUDE_PLUGIN_DATA` isolated per test.

The per-turn change record lives in
`${CLAUDE_PLUGIN_DATA}/turns/<session_id>.jsonl`, or in the temp directory when
that variable is absent. It is append-only: hooks from one batch write
concurrently, and appending a short line is atomic where read-modify-write is
not.

## Related projects

- [claude-md-memory-guardian](https://github.com/brannon-bowden/claude-md-memory-guardian) — hooks against CLAUDE.md rules being forgotten after compaction.
- [claude-core-values](https://github.com/albertnahas/claude-core-values) — the SessionStart + UserPromptSubmit layers, MIT.
- [claude-code-hooks](https://github.com/karanb192/claude-code-hooks) — its `dead-rules-audit` plugin scores chronically ignored rules. Useful alongside this one as a measuring device: its data shows which rules are worth promoting to `permissions.deny`.

## License

MIT.
