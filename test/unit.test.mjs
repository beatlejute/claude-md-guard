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
