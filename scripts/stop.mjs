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
      'End your answer with "**CLAUDE.md**" on its own line, then a blank line, then unindented checklist items:',
      '"- [x] <rule>" where the turn followed it, "- [ ] <rule> — <what went wrong and where>" where it did not.',
      'The blank line matters: without it the items nest under the heading instead of rendering as checkboxes.',
      'Cover only the rules that bear on this turn, leave the rest out rather than listing them as not applicable, and fix the unchecked ones before finishing.',
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
 * Does the finished answer already carry the checklist?
 *
 * Two or more checklist items, or two or more lines ending in a verdict word
 * for answers written before the checklist format, and CLAUDE.md named
 * somewhere in the message. That last condition is what separates a compliance
 * checklist from an ordinary plan written as checkboxes.
 */
function hasComplianceList(lastAssistantMessage) {
  if (typeof lastAssistantMessage !== 'string') return false;
  if (!/CLAUDE\.md/i.test(lastAssistantMessage)) return false;

  // The bullet is optional: the asked-for format is a bare `[x]`, but a model
  // that reaches for `- [x]` out of markdown habit still produced a checklist.
  const items = lastAssistantMessage.match(/^[^\S\n]*(?:[-*]\s*)?\[[ xX]\]/gm) || [];
  const verdicts = lastAssistantMessage.match(
    /^[^\S\n]*[-*•]?[^\n]*[—–:-][^\S\n]*(followed|violated|not applicable)\b/gim,
  ) || [];
  return items.length >= 2 || verdicts.length >= 2;
}
