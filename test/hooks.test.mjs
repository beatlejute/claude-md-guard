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

test('SessionStart keeps the injection under the Claude Code file-out limit', () => {
  const env = isolated();
  const cwd = sandbox('cmg-big-');
  writeFileSync(
    join(cwd, 'CLAUDE.md'),
    Array.from({ length: 900 }, (_, i) => `* правило номер ${i}`).join('\n'),
  );

  const out = runHook('session-start.mjs', {
    session_id: 'sess-big',
    cwd,
    source: 'startup',
  }, env);

  const context = out.hookSpecificOutput.additionalContext;
  assert.ok(context.length < 10000, `would be filed out by Claude Code: ${context.length}`);
  assert.match(context, /правило номер 0/, 'the rules themselves must be inline');
  assert.match(context, /cut short at the context budget/, 'the cut must be declared');
});

test('UserPromptSubmit asks for a rule-by-rule verdict in the output', () => {
  const out = runHook('user-prompt-submit.mjs', {
    session_id: 'sess-4',
    cwd: projectWithRules(),
    prompt: 'refactor this',
  }, isolated());

  const context = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(context, /CLAUDE\.md/);
  assert.match(context, /concludes, analyses or recommends/);
  assert.match(context, /no bullet or indent/, 'the format must forbid bullets');
  assert.match(context, /"\[x\] <rule>"/, 'the checklist format must be spelled out');
  assert.match(context, /"\[ \] <rule>/);
  assert.match(context, /Status updates and short factual replies carry no checklist/, 'status replies must be exempt');
  assert.ok(context.split('\n').length === 1, 'the reminder must be a single line');
  assert.ok(context.length < 600, `too long: ${context.length}`);
});

test('the 0.2.0 name "always" still selects the analysis level', () => {
  const env = { ...isolated(), CLAUDE_MD_GUARD_COMPLIANCE_REPORT: 'always' };
  const out = runHook('user-prompt-submit.mjs', {
    session_id: 'sess-4d',
    cwd: projectWithRules(),
    prompt: 'refactor this',
  }, env);
  assert.match(out.hookSpecificOutput.additionalContext, /concludes, analyses or recommends/);
});

test('UserPromptSubmit drops the report demand when complianceReport is off', () => {
  const env = { ...isolated(), CLAUDE_MD_GUARD_COMPLIANCE_REPORT: 'off' };
  const out = runHook('user-prompt-submit.mjs', {
    session_id: 'sess-4b',
    cwd: projectWithRules(),
    prompt: 'refactor this',
  }, env);

  const context = out.hookSpecificOutput.additionalContext;
  assert.match(context, /CLAUDE\.md/);
  assert.ok(!/concludes, analyses or recommends/.test(context), 'the report demand must be gone');
  assert.ok(context.length < 200, `too long: ${context.length}`);
});

test('UserPromptSubmit stays short when complianceReport is limited to changes', () => {
  const env = { ...isolated(), CLAUDE_MD_GUARD_COMPLIANCE_REPORT: 'changes' };
  const out = runHook('user-prompt-submit.mjs', {
    session_id: 'sess-4c',
    cwd: projectWithRules(),
    prompt: 'refactor this',
  }, env);

  assert.ok(!/concludes, analyses or recommends/.test(out.hookSpecificOutput.additionalContext));
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
  assert.match(stop.hookSpecificOutput.additionalContext, /"\[x\] <rule>"/);
  assert.match(stop.hookSpecificOutput.additionalContext, /"\[ \] <rule>/);

  const again = runHook('stop.mjs', {
    session_id: 'sess-7',
    cwd,
    stop_hook_active: false,
  }, env);
  assert.equal(again, null, 'the record must be cleared after the first firing');
});

test('Stop does not ask again when the answer already carries the list', () => {
  const env = isolated();
  const cwd = projectWithRules();
  runHook('post-tool-use.mjs', {
    session_id: 'sess-11',
    cwd,
    tool_name: 'Edit',
    tool_input: { file_path: join(cwd, 'api.ts') },
  }, env);

  const out = runHook('stop.mjs', {
    session_id: 'sess-11',
    cwd,
    stop_hook_active: false,
    last_assistant_message: [
      'Done, the client now retries once.',
      '',
      'CLAUDE.md:',
      '[x] Answer in Russian',
      '[ ] Worktree first for client code — edited on main instead',
    ].join('\n'),
  }, env);
  assert.equal(out, null, 'the checklist is already there; asking again would print it twice');
});

test('Stop also recognizes a checklist a model wrote with markdown bullets', () => {
  const env = isolated();
  const cwd = projectWithRules();
  runHook('post-tool-use.mjs', {
    session_id: 'sess-11d',
    cwd,
    tool_name: 'Edit',
    tool_input: { file_path: join(cwd, 'api.ts') },
  }, env);

  const out = runHook('stop.mjs', {
    session_id: 'sess-11d',
    cwd,
    stop_hook_active: false,
    last_assistant_message: 'CLAUDE.md:\n- [x] Answer in Russian\n- [ ] Be brief — three paragraphs',
  }, env);
  assert.equal(out, null, 'the bullet is a habit, not a different report');
});

test('Stop recognizes the pre-checklist verdict format too', () => {
  const env = isolated();
  const cwd = projectWithRules();
  runHook('post-tool-use.mjs', {
    session_id: 'sess-11b',
    cwd,
    tool_name: 'Edit',
    tool_input: { file_path: join(cwd, 'api.ts') },
  }, env);

  const out = runHook('stop.mjs', {
    session_id: 'sess-11b',
    cwd,
    stop_hook_active: false,
    last_assistant_message: 'CLAUDE.md:\n- Answer in Russian — followed\n- Worktree first — violated: edited on main',
  }, env);
  assert.equal(out, null);
});

test('Stop is not fooled by an ordinary plan written as checkboxes', () => {
  const env = isolated();
  const cwd = projectWithRules();
  runHook('post-tool-use.mjs', {
    session_id: 'sess-11c',
    cwd,
    tool_name: 'Edit',
    tool_input: { file_path: join(cwd, 'api.ts') },
  }, env);

  const out = runHook('stop.mjs', {
    session_id: 'sess-11c',
    cwd,
    stop_hook_active: false,
    last_assistant_message: 'Plan:\n- [x] add the retry\n- [ ] cover it with a test',
  }, env);
  assert.ok(out, 'a plan is not a compliance checklist');
});

test('Stop still asks when the answer only mentions a verdict word in prose', () => {
  const env = isolated();
  const cwd = projectWithRules();
  runHook('post-tool-use.mjs', {
    session_id: 'sess-12',
    cwd,
    tool_name: 'Edit',
    tool_input: { file_path: join(cwd, 'api.ts') },
  }, env);

  const out = runHook('stop.mjs', {
    session_id: 'sess-12',
    cwd,
    stop_hook_active: false,
    last_assistant_message: 'I followed the plan and rewrote the retry logic.',
  }, env);
  assert.ok(out, 'one stray "followed" in prose is not a compliance list');
  assert.match(out.hookSpecificOutput.additionalContext, /rule by rule/);
});

test('Stop asks again when complianceReport is off, list or not', () => {
  const env = { ...isolated(), CLAUDE_MD_GUARD_COMPLIANCE_REPORT: 'off' };
  const cwd = projectWithRules();
  runHook('post-tool-use.mjs', {
    session_id: 'sess-13',
    cwd,
    tool_name: 'Edit',
    tool_input: { file_path: join(cwd, 'api.ts') },
  }, env);

  const out = runHook('stop.mjs', {
    session_id: 'sess-13',
    cwd,
    stop_hook_active: false,
    last_assistant_message: '- Rule A — followed\n- Rule B — followed',
  }, env);
  assert.ok(out, 'with the report off the plain check is still due');
});

test('Stop falls back to the plain wording when complianceReport is off', () => {
  const env = { ...isolated(), CLAUDE_MD_GUARD_COMPLIANCE_REPORT: 'off' };
  const cwd = projectWithRules();
  runHook('post-tool-use.mjs', {
    session_id: 'sess-7b',
    cwd,
    tool_name: 'Write',
    tool_input: { file_path: join(cwd, 'notes.md') },
  }, env);

  const stop = runHook('stop.mjs', { session_id: 'sess-7b', cwd, stop_hook_active: false }, env);
  const context = stop.hookSpecificOutput.additionalContext;
  assert.match(context, /notes\.md/);
  assert.ok(!/\[x\] <rule>/.test(context));
});

test('Stop still asks for the report when it is limited to changes', () => {
  const env = { ...isolated(), CLAUDE_MD_GUARD_COMPLIANCE_REPORT: 'changes' };
  const cwd = projectWithRules();
  runHook('post-tool-use.mjs', {
    session_id: 'sess-7c',
    cwd,
    tool_name: 'Edit',
    tool_input: { file_path: join(cwd, 'z.ts') },
  }, env);

  const stop = runHook('stop.mjs', { session_id: 'sess-7c', cwd, stop_hook_active: false }, env);
  assert.match(stop.hookSpecificOutput.additionalContext, /rule by rule/);
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
