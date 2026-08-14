#!/usr/bin/env node
/**
 * UserPromptSubmit: a one-line request to verify, ~20 tokens per turn.
 *
 * It is phrased as a request for action, not as a statement of fact: "CLAUDE.md
 * is in force" reads as background and produces nothing, while "check yourself
 * against CLAUDE.md" names an action. No files are read here — this hook blocks
 * prompt submission, so it has to be instant.
 */

import { additionalContext, readInput, run } from './lib/hook-io.mjs';
import { loadConfig, message } from './lib/config.mjs';

run(async () => {
  const input = await readInput();
  const config = loadConfig(input.cwd);
  if (!config.promptReminder) return null;

  return additionalContext(
    'UserPromptSubmit',
    message(
      config,
      'promptReminder',
      'Check your plan and your actions for this turn against CLAUDE.md before acting; where they differ, CLAUDE.md wins.',
    ),
  );
});
