#!/usr/bin/env node
/**
 * Stop: before a turn that changed state is allowed to finish, ask for a pass
 * over the whole turn against CLAUDE.md.
 *
 * Two mandatory safeguards:
 *  • stop_hook_active === true — Claude Code is already continuing because of a
 *    Stop hook, and blocking again would loop the session;
 *  • an empty record — the turn changed nothing, and blocking a conversational
 *    reply would force a second round onto every single answer.
 */

import { additionalContext, readInput, run } from './lib/hook-io.mjs';
import { loadConfig, message } from './lib/config.mjs';
import { clearTurn, readTurn } from './lib/state.mjs';

const MAX_LISTED = 8;

run(async () => {
  const input = await readInput();
  if (input.stop_hook_active === true) return null;

  const config = loadConfig(input.cwd);
  const events = readTurn(input.session_id);
  if (events.length === 0) return null;

  // Clear the record before replying: the next Stop of this turn must pass.
  clearTurn(input.session_id);
  if (config.stopMode === 'off') return null;

  // Layer 2 already asked for the list, and the answer carries one. Asking
  // again would print it twice and cost an extra model round for nothing.
  if (config.complianceReport !== 'off' && hasComplianceList(input.last_assistant_message)) {
    return null;
  }

  const text = message(config, 'stop', render(events, config));
  if (config.stopMode === 'block') return { decision: 'block', reason: text };
  return additionalContext('Stop', text);
});

function render(events, config) {
  const listed = events.slice(0, MAX_LISTED).map(describe);
  const rest = events.length - listed.length;
  const tail = rest > 0 ? `, and ${rest} more change${rest === 1 ? '' : 's'}` : '';
  const parts = [`This turn changed: ${listed.join('; ')}${tail}.`];

  if (config.complianceReport === 'off') {
    parts.push(
      'Re-read CLAUDE.md, check the whole turn against it, and fix anything that breaks a rule before finishing.',
      'If the turn already follows the rules, say so in one line and finish.',
    );
  } else {
    parts.push(
      'Re-read CLAUDE.md and go through it rule by rule against this turn.',
      'Show the result in your answer as one line per rule that actually bears on this turn, in the form',
      '"<rule> — followed" or "<rule> — violated: <what and where>".',
      'Leave every other rule out entirely rather than listing it as not applicable, and fix what is violated before finishing.',
    );
  }
  return parts.join(' ');
}

function describe(event) {
  const action = event.action || 'changed something';
  if (!event.target) return action;
  if (action.startsWith('ran a shell')) return `${action}: \`${event.target}\``;
  return `${action} ${event.target}`;
}

/**
 * Does the finished answer already carry a rule-by-rule list?
 *
 * Two or more lines ending in the verdict word is the signature; one stray
 * mention of "followed" in prose is not. Matched case-insensitively and
 * across the dash characters models actually produce.
 */
function hasComplianceList(lastAssistantMessage) {
  if (typeof lastAssistantMessage !== 'string') return false;
  const verdicts = lastAssistantMessage.match(
    /^[^\S\n]*[-*•]?[^\n]*[—–:-][^\S\n]*(followed|violated|not applicable)\b/gim,
  );
  return Boolean(verdicts) && verdicts.length >= 2;
}
