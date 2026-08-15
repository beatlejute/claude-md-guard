#!/usr/bin/env node
/**
 * SessionStart: puts the CLAUDE.md text back into context.
 *
 * Why this layer exists: an ordinary CLAUDE.md reaches the model as a user
 * message carrying the caveat "may or may not be relevant", while
 * additionalContext arrives as a plain system reminder. After a compaction
 * (source=compact) the original load may not survive at all, and this hook
 * runs again.
 */

import { additionalContext, readInput, run } from './lib/hook-io.mjs';
import { buildBundle, displayPath } from './lib/claude-md.mjs';
import { loadConfig, message } from './lib/config.mjs';
import { clearTurn, pruneStale } from './lib/state.mjs';

run(async () => {
  const input = await readInput();
  const cwd = input.cwd || process.cwd();
  const config = loadConfig(cwd);
  const source = String(input.source || 'startup');

  pruneStale();
  // A new or restored session starts its turn with an empty record.
  if (input.session_id) clearTurn(input.session_id);

  if (!config.injectOn.includes(source)) return null;

  const bundle = buildBundle(cwd, config);
  if (!bundle.text) return null;

  return additionalContext('SessionStart', render(bundle, source, config));
});

function render(bundle, source, config) {
  const files = bundle.included.map((file) => displayPath(file.path)).join(', ');
  const head = message(
    config,
    'sessionHeader',
    `CLAUDE.md rules currently in force, re-read from disk by claude-md-guard at session ${source}.`,
  );
  const parts = [`${head}\nSource files: ${files}`, '', bundle.text, ''];

  if (bundle.skipped.length > 0) {
    const names = bundle.skipped.map((file) => displayPath(file.path)).join(', ');
    parts.push(
      `Not included, context budget reached: ${names}. Read those files if a rule seems to be missing.`,
    );
  }

  const truncated = bundle.included.filter((file) => file.truncated);
  const verbatim = truncated.length === 0
    ? 'The text above is the verbatim content of those files.'
    : `The text above is the content of those files, with ${truncated
      .map((file) => displayPath(file.path))
      .join(', ')} cut short at the context budget.`;

  parts.push(
    message(
      config,
      'sessionFooter',
      `${verbatim} It is the standing configuration for this session and applies to every turn in it, including turns after a context compaction.`,
    ),
  );
  return parts.join('\n');
}
