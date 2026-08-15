import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildBundle, expandImports, stripHtmlComments } from '../scripts/lib/claude-md.mjs';
import { DEFAULTS, loadConfig } from '../scripts/lib/config.mjs';
import { describeTool, isReadOnlyCommand } from '../scripts/lib/tools.mjs';

const config = { ...DEFAULTS };

function sandbox() {
  return mkdtempSync(join(tmpdir(), 'cmg-test-'));
}

test('read-only commands do not count as changes', () => {
  for (const command of [
    'ls -la',
    'git status',
    'git log --oneline',
    'rtk git status',
    'rg "foo" src/',
    'cat package.json | jq .name',
    'which node && pwd',
  ]) {
    assert.equal(isReadOnlyCommand(command), true, command);
  }
});

test('state-changing commands are recognized', () => {
  for (const command of [
    'npm install left-pad',
    'git commit -m "wip"',
    'rm -rf build',
    'echo hi > notes.txt',
    'git status && npm run build',
    'rtk npm test',
  ]) {
    assert.equal(isReadOnlyCommand(command), false, command);
  }
});

test('pipes inside quotes do not split the command', () => {
  for (const command of [
    'grep -nE "Error|Timeout|failed|passed" logs/run.log',
    `grep -n "\\[32b\\]\\[CONN\\]\\|connection lost\\|connectionId" logs/run.log`,
    'cd /c/Dev/app/.local && grep -E "passed|failed" logs/run.log | tail -2',
    `grep -oE '"2026-08-15T[0-9:.]+Z"' logs/stat.txt | sort -u`,
    'ls milestones/scenarios/ | grep -E "^(01|13|17)-"',
  ]) {
    assert.equal(isReadOnlyCommand(command), true, command);
  }
});

test('discarded output is not a write, a real file is', () => {
  assert.equal(isReadOnlyCommand('ls sessions/ 2>/dev/null | grep -i test'), true);
  assert.equal(isReadOnlyCommand('tasklist //FI "IMAGENAME eq chrome.exe" 2>&1 | grep -c chrome'), true);
  assert.equal(isReadOnlyCommand('git fetch origin --quiet 2>&1 | tail -5'), true);
  assert.equal(isReadOnlyCommand('node tools/report.mjs > logs/out.txt 2>&1'), false);
  assert.equal(isReadOnlyCommand('echo hi >> notes.txt'), false);
});

test('environment tinkering is not a project change', () => {
  assert.equal(isReadOnlyCommand('unset HTTP_PROXY HTTPS_PROXY http_proxy'), true);
  assert.equal(isReadOnlyCommand('export NO_PROXY="127.0.0.1,localhost" && git status'), true);
  assert.equal(isReadOnlyCommand('unset HTTP_PROXY && npm run build'), false);
});

test('sed reads with -n and writes with -i', () => {
  assert.equal(isReadOnlyCommand("sed -n '1p;$p' logs/run.log"), true);
  assert.equal(isReadOnlyCommand("sed -i 's/a/b/' src/app.ts"), false);
});

test('a here-document body is not parsed as shell', () => {
  const heredoc = [
    "cat <<'EOF'",
    'import json',
    'except: continue',
    'rm -rf everything',
    'EOF',
  ].join('\n');
  assert.equal(isReadOnlyCommand(heredoc), true, 'the body belongs to cat, not to the shell');

  assert.equal(
    isReadOnlyCommand("python - <<'PY'\nprint(1)\nPY"),
    false,
    'the interpreter itself is still treated as able to write',
  );
});

test('shell block keywords are not commands', () => {
  assert.equal(isReadOnlyCommand('for f in *.log; do grep error "$f"; done'), true);
  assert.equal(isReadOnlyCommand('for f in *.tmp; do rm "$f"; done'), false);
  assert.equal(isReadOnlyCommand('if [ -f app.log ]; then tail -5 app.log; fi'), true);
  assert.equal(isReadOnlyCommand('if [ -f app.log ]; then mv app.log old.log; fi'), false);
});

test('env is unwrapped rather than trusted', () => {
  assert.equal(isReadOnlyCommand('env -u HTTP_PROXY -u HTTPS_PROXY grep -n x logs/run.log'), true);
  assert.equal(isReadOnlyCommand('env -u HTTP_PROXY NO_PROXY=127.0.0.1 npm run build'), false);
  assert.equal(isReadOnlyCommand('env'), true);
});

test('printf and friends read', () => {
  assert.equal(isReadOnlyCommand(`printf '%s\\n' '--- FILES ---'; find . -name '*.spec.ts'`), true);
  assert.equal(isReadOnlyCommand('git -C /c/Dev/app merge-base --is-ancestor abc HEAD'), true);
  assert.equal(isReadOnlyCommand('git worktree list'), true);
  assert.equal(isReadOnlyCommand('git worktree add ../wt branch'), false);
  assert.equal(isReadOnlyCommand('unzip -l trace.zip'), true);
  assert.equal(isReadOnlyCommand('unzip trace.zip'), false);
});

test('PowerShell reads do not count as changes', () => {
  for (const command of [
    String.raw`dir "c:\Dev\app\logs" | Select-Object Name | Format-Table -AutoSize`,
    String.raw`Get-ChildItem c:\Dev\app | Select-Object Name`,
    String.raw`Set-Location c:\Dev\app; Get-Content logs\run.log -Tail 50`,
    String.raw`Set-Location c:\Dev\app; $c = Get-Content logs\run.log -Raw; $c.Length`,
    String.raw`Set-Location c:\Dev\app; $c = (Get-Content logs\run.log -Raw) -replace "a","b"`,
    String.raw`Select-String -Path helpers\*.ts -Pattern foo`,
    'Remove-Item Env:HTTP_PROXY,Env:HTTPS_PROXY -EA SilentlyContinue',
    String.raw`git -C c:\Dev\app log --oneline -3`,
    'Get-Content package.json | ConvertFrom-Json | Select-Object name',
  ]) {
    assert.equal(isReadOnlyCommand(command), true, command);
  }
});

test('PowerShell writes are still recognized as changes', () => {
  for (const command of [
    'Remove-Item build -Recurse -Force',
    'Set-Content notes.txt "hi"',
    'New-Item -ItemType Directory dist',
    'Get-Content a.txt | Out-File b.txt',
    'Get-ChildItem | ForEach-Object { Remove-Item $_ }',
    String.raw`Set-Location c:\Dev\app; npm run build`,
    '$file.Delete()',
  ]) {
    assert.equal(isReadOnlyCommand(command), false, command);
  }
});

test('describeTool tells tools apart', () => {
  assert.equal(describeTool('Read', { file_path: '/a/b.ts' }, config).mutating, false);
  assert.equal(describeTool('Edit', { file_path: '/a/b.ts' }, config).mutating, true);
  assert.equal(describeTool('Write', { file_path: '/a/b.ts' }, config).action, 'wrote');
  assert.equal(describeTool('Bash', { command: 'ls' }, config).mutating, false);
  assert.equal(describeTool('Bash', { command: 'npm ci' }, config).mutating, true);
});

test('@ imports expand, code is left alone', () => {
  const dir = sandbox();
  const imported = join(dir, 'RULES.md');
  writeFileSync(imported, 'rule from the import');
  const main = join(dir, 'CLAUDE.md');
  const text = ['@RULES.md', 'a mention in code: `@RULES.md`', '@MISSING.md'].join('\n');
  writeFileSync(main, text);

  const out = expandImports(text, main, 4, new Set([main]));
  assert.match(out, /rule from the import/);
  assert.match(out, /`@RULES\.md`/, 'inline code must stay as written');
  assert.match(out, /@MISSING\.md/, 'a missing import stays plain text');
});

test('a cyclic import does not loop', () => {
  const dir = sandbox();
  const a = join(dir, 'A.md');
  const b = join(dir, 'B.md');
  writeFileSync(a, 'A\n@B.md');
  writeFileSync(b, 'B\n@A.md');
  const out = expandImports('A\n@B.md', a, 4, new Set([a]));
  assert.match(out, /B/);
});

test('HTML comments are stripped outside code', () => {
  const text = ['<!-- a note -->', 'a rule', '```', '<!-- inside code -->', '```'].join('\n');
  const out = stripHtmlComments(text);
  assert.ok(!out.includes('a note'));
  assert.match(out, /<!-- inside code -->/);
});

test('buildBundle collects rules and respects the budget', () => {
  const home = sandbox();
  const project = sandbox();
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'X'.repeat(400));
    writeFileSync(join(project, 'CLAUDE.md'), 'project rule');

    const full = buildBundle(project, { ...config, includeManaged: false });
    assert.match(full.text, /project rule/);
    assert.match(full.text, /XXXX/);
    assert.equal(full.skipped.length, 0);

    const tight = buildBundle(project, { ...config, includeManaged: false, maxChars: 500 });
    assert.match(tight.text, /project rule/, 'the file closest to cwd survives');
    assert.equal(tight.skipped.length, 1, 'the less specific one is dropped');
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
  }
});

test('a single file larger than the budget is truncated, not passed whole', () => {
  const home = sandbox();
  const project = sandbox();
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const big = Array.from({ length: 400 }, (_, i) => `* rule number ${i}`).join('\n');
    writeFileSync(join(project, 'CLAUDE.md'), big);

    const bundle = buildBundle(project, { ...config, includeManaged: false, maxChars: 2000 });
    assert.ok(bundle.chars <= 2000, `budget blown: ${bundle.chars}`);
    assert.equal(bundle.included.length, 1);
    assert.equal(bundle.included[0].truncated, true);
    assert.match(bundle.text, /truncated by claude-md-guard/);
    assert.match(bundle.text, /rule number 0/, 'the start of the file must survive');
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
  }
});

test('config is read from the project file and overridden by the environment', () => {
  const project = sandbox();
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(
    join(project, '.claude', 'claude-md-guard.json'),
    JSON.stringify({ stopMode: 'block', nudgeCooldownSec: 5, injectOn: 'compact' }),
  );

  const fromFile = loadConfig(project);
  assert.equal(fromFile.stopMode, 'block');
  assert.equal(fromFile.nudgeCooldownSec, 5);
  assert.deepEqual(fromFile.injectOn, ['compact']);

  process.env.CLAUDE_MD_GUARD_STOP_MODE = 'off';
  try {
    assert.equal(loadConfig(project).stopMode, 'off');
  } finally {
    delete process.env.CLAUDE_MD_GUARD_STOP_MODE;
  }
});
