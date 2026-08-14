/**
 * Running the hook scripts themselves: stdin gets the same JSON Claude Code
 * sends, and stdout is checked against what the hook should reply.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

function sandbox(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Runs a hook in isolation: its own HOME, its own state directory. */
function runHook(script, input, env = {}) {
  const stdout = execFileSync(process.execPath, [join(SCRIPTS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (!stdout.trim()) return null;
  return JSON.parse(stdout);
}

function projectWithRules(text = 'project rule: no commits without tests') {
  const dir = sandbox('cmg-proj-');
  writeFileSync(join(dir, 'CLAUDE.md'), text);
  return dir;
}

function isolated() {
  const home = sandbox('cmg-home-');
  mkdirSync(join(home, '.claude'), { recursive: true });
  return {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_PLUGIN_DATA: sandbox('cmg-data-'),
    CLAUDE_MD_GUARD_INCLUDE_MANAGED: '0',
  };
}

test('SessionStart injects the rules', () => {
  const env = isolated();
  const cwd = projectWithRules();
  const out = runHook('session-start.mjs', {
    session_id: 'sess-1',
    cwd,
    hook_event_name: 'SessionStart',
    source: 'compact',
  }, env);

  assert.ok(out, 'expected a hook reply');
  const context = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(context, /project rule/);
  assert.match(context, /compact/);
});

test('SessionStart stays quiet for a source outside injectOn', () => {
  const env = { ...isolated(), CLAUDE_MD_GUARD_INJECT_ON: 'compact' };
  const out = runHook('session-start.mjs', {
    session_id: 'sess-2',
    cwd: projectWithRules(),
    source: 'startup',
  }, env);
  assert.equal(out, null);
});

test('SessionStart stays quiet when there are no rules', () => {
  const out = runHook('session-start.mjs', {
    session_id: 'sess-3',
    cwd: sandbox('cmg-empty-'),
    source: 'startup',
  }, isolated());
  assert.equal(out, null);
});

test('UserPromptSubmit returns a one-line request to verify', () => {
  const out = runHook('user-prompt-submit.mjs', {
    session_id: 'sess-4',
    cwd: projectWithRules(),
    prompt: 'refactor this',
  }, isolated());

  const context = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(context, /CLAUDE\.md/);
  assert.ok(context.split('\n').length === 1, 'the reminder must be a single line');
  assert.ok(context.length < 200, `too long: ${context.length}`);
});

test('PostToolUse nudges after Edit and stays quiet after a read', () => {
  const env = isolated();
  const cwd = projectWithRules();

  const edit = runHook('post-tool-use.mjs', {
    session_id: 'sess-5',
    cwd,
    tool_name: 'Edit',
    tool_input: { file_path: join(cwd, 'src', 'api.ts') },
  }, env);
  assert.match(edit.hookSpecificOutput.additionalContext, /api\.ts/);
  assert.match(edit.hookSpecificOutput.additionalContext, /CLAUDE\.md/);

  const read = runHook('post-tool-use.mjs', {
    session_id: 'sess-5',
    cwd,
    tool_name: 'Bash',
    tool_input: { command: 'git status' },
  }, env);
  assert.equal(read, null, 'git status warrants no nudge');
});

test('PostToolUse does not repeat the nudge within the cooldown', () => {
  const env = { ...isolated(), CLAUDE_MD_GUARD_NUDGE_COOLDOWN_SEC: '3600' };
  const cwd = projectWithRules();
  const call = (file) => runHook('post-tool-use.mjs', {
    session_id: 'sess-6',
    cwd,
    tool_name: 'Edit',
    tool_input: { file_path: join(cwd, file) },
  }, env);

  assert.ok(call('a.ts'), 'the first change is always nudged');
  assert.equal(call('b.ts'), null, 'the second falls inside the cooldown');
});

test('Stop asks for a check after a changing turn and clears the record', () => {
  const env = isolated();
  const cwd = projectWithRules();
  runHook('post-tool-use.mjs', {
    session_id: 'sess-7',
    cwd,
    tool_name: 'Write',
    tool_input: { file_path: join(cwd, 'README.md') },
  }, env);

  const stop = runHook('stop.mjs', {
    session_id: 'sess-7',
    cwd,
    stop_hook_active: false,
  }, env);
  assert.match(stop.hookSpecificOutput.additionalContext, /README\.md/);
  assert.match(stop.hookSpecificOutput.additionalContext, /CLAUDE\.md/);

  const again = runHook('stop.mjs', {
    session_id: 'sess-7',
    cwd,
    stop_hook_active: false,
  }, env);
  assert.equal(again, null, 'the record must be cleared after the first firing');
});

test('Stop stays quiet on a conversational turn', () => {
  const out = runHook('stop.mjs', {
    session_id: 'sess-8',
    cwd: projectWithRules(),
    stop_hook_active: false,
  }, isolated());
  assert.equal(out, null);
});

test('Stop does not loop when stop_hook_active is set', () => {
  const env = isolated();
  const cwd = projectWithRules();
  runHook('post-tool-use.mjs', {
    session_id: 'sess-9',
    cwd,
    tool_name: 'Edit',
    tool_input: { file_path: join(cwd, 'x.ts') },
  }, env);

  const out = runHook('stop.mjs', {
    session_id: 'sess-9',
    cwd,
    stop_hook_active: true,
  }, env);
  assert.equal(out, null);
});

test('Stop in block mode returns a decision', () => {
  const env = { ...isolated(), CLAUDE_MD_GUARD_STOP_MODE: 'block' };
  const cwd = projectWithRules();
  runHook('post-tool-use.mjs', {
    session_id: 'sess-10',
    cwd,
    tool_name: 'Edit',
    tool_input: { file_path: join(cwd, 'y.ts') },
  }, env);

  const out = runHook('stop.mjs', { session_id: 'sess-10', cwd, stop_hook_active: false }, env);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /y\.ts/);
});

test('malformed stdin does not crash the hook', () => {
  const stdout = execFileSync(process.execPath, [join(SCRIPTS, 'stop.mjs')], {
    input: 'not json',
    encoding: 'utf8',
    env: { ...process.env, ...isolated() },
  });
  assert.equal(stdout.trim(), '');
});

test('the hook scripts are all present', () => {
  for (const name of [
    'session-start.mjs',
    'user-prompt-submit.mjs',
    'post-tool-use.mjs',
    'stop.mjs',
  ]) {
    assert.ok(existsSync(join(SCRIPTS, name)), name);
  }
});
