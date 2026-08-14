#!/usr/bin/env node
/**
 * PostToolUse: a nudge tied to the specific action, plus the record that this
 * turn changed state.
 *
 * Being specific ("you just edited src/api.ts") is the antidote to habituation:
 * identical text at every step stops being read. The record is what the Stop
 * layer needs — it leaves conversational turns alone.
 */

import { additionalContext, readInput, run } from './lib/hook-io.mjs';
import { loadConfig, message } from './lib/config.mjs';
import { readTurn, recordChange } from './lib/state.mjs';
import { describeTool } from './lib/tools.mjs';

const NUDGES = [
  (what) => `You just ${what}. Re-read the CLAUDE.md rules that apply to it and fix any violation now, before the next step.`,
  (what) => `${capitalize(what)} in this turn. Check that change against CLAUDE.md — the rules apply to it as written, not approximately.`,
  (what) => `You ${what}. If any CLAUDE.md rule covers this file or command, verify the change follows it before continuing.`,
  (what) => `Change recorded: you ${what}. Compare it with CLAUDE.md and correct it here rather than at the end of the turn.`,
];

run(async () => {
  const input = await readInput();
  const config = loadConfig(input.cwd);
  const info = describeTool(input.tool_name, input.tool_input, config);
  if (!info.mutating) return null;

  const sessionId = input.session_id;
  const history = readTurn(sessionId);
  const now = Date.now();
  const nudge = shouldNudge(history, info, now, config);

  recordChange(sessionId, {
    at: now,
    tool: input.tool_name || 'unknown',
    action: info.action,
    target: info.target,
    nudged: nudge,
  });

  if (!nudge) return null;

  const template = NUDGES[countNudges(history) % NUDGES.length];
  const text = message(config, 'nudge', template(describe(info)));
  return additionalContext('PostToolUse', text);
});

function shouldNudge(history, info, now, config) {
  const nudged = history.filter((event) => event.nudged);
  if (nudged.length === 0) return true;

  const cooldownMs = Math.max(0, Number(config.nudgeCooldownSec) || 0) * 1000;
  const last = nudged.reduce((max, event) => Math.max(max, Number(event.at) || 0), 0);
  if (now - last >= cooldownMs) return true;

  if (config.nudgeOnNewFile && info.target) {
    return !history.some((event) => event.target === info.target);
  }
  return false;
}

function countNudges(history) {
  return history.filter((event) => event.nudged).length;
}

function describe(info) {
  if (!info.target) return info.action;
  if (info.action.startsWith('ran a shell')) return `${info.action}: \`${info.target}\``;
  return `${info.action} ${info.target}`;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
