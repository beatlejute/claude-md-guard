#!/usr/bin/env node
/**
 * UserPromptSubmit: a short request to verify, ~20–50 tokens per turn.
 *
 * It is phrased as a request for action, not as a statement of fact: "CLAUDE.md
 * is in force" reads as background and produces nothing, while "check yourself
 * against CLAUDE.md" names an action. With complianceReport on, the request
 * goes further and asks for the verdict per rule — a demand that cannot be
 * satisfied by silently thinking about it.
 *
 * No files are read here — this hook blocks prompt submission, so it has to be
 * instant.
 */

import { additionalContext, readInput, run } from './lib/hook-io.mjs';
import { loadConfig, message } from './lib/config.mjs';

const BASE =
  'Check your plan and your actions for this turn against CLAUDE.md before acting; where they differ, CLAUDE.md wins.';

const REPORT =
  ' When you present output or analysis, state how it lines up with CLAUDE.md rule by rule: one line per applicable rule, each marked followed or violated, and fix what is violated before presenting it.';

run(async () => {
  const input = await readInput();
  const config = loadConfig(input.cwd);
  if (!config.promptReminder) return null;

  const text = config.complianceReport === 'always' ? BASE + REPORT : BASE;
  return additionalContext('UserPromptSubmit', message(config, 'promptReminder', text));
});
