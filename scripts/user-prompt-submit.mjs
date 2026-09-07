#!/usr/bin/env node
/**
 * UserPromptSubmit: a short request to verify, ~20–50 tokens per turn.
 *
 * It is phrased as a request for action, not as a statement of fact: "CLAUDE.md
 * is in force" reads as background and produces nothing, while "check yourself
 * against CLAUDE.md" names an action. With complianceReport on, the request
 * goes further and asks for the verdict per rule — a demand that cannot be
 * satisfied by silently thinking about it. The exemption for status updates
 * matters as much as the demand: a compliance list under a one-line status
 * reply is noise, and noise is what trains the model to skip the list.
 *
 * No files are read here — this hook blocks prompt submission, so it has to be
 * instant.
 */

import { additionalContext, isDelegate, readInput, run } from './lib/hook-io.mjs';
import { loadConfig, message } from './lib/config.mjs';

const BASE =
  'Check your plan and your actions for this turn against CLAUDE.md before acting; where they differ, CLAUDE.md wins.';

const REPORT =
  ' When your answer concludes, analyses or recommends, end it with "**CLAUDE.md**" on its own line, a blank line, then the rules bearing on this turn — quoted in the wording CLAUDE.md uses and in the order they appear there — each as "- [x] <rule>" where you followed it or "- [ ] <rule> — <what and where>" where you did not. Re-read the rules rather than recalling them: a rule you cannot quote is a rule you did not check. Status updates and short factual replies carry no checklist.';

run(async () => {
  const input = await readInput();
  const config = loadConfig(input.cwd);
  if (!config.promptReminder) return null;

  const wantsReport = config.complianceReport === 'analysis' && !isDelegate();
  const text = wantsReport ? BASE + REPORT : BASE;
  return additionalContext('UserPromptSubmit', message(config, 'promptReminder', text));
});
