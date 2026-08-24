/**
 * claude-md-guard configuration.
 *
 * Precedence, lowest first: defaults → ~/.claude/claude-md-guard.json →
 * <project>/.claude/claude-md-guard.json → CLAUDE_MD_GUARD_* environment
 * variables. None of the sources is required: with no config at all the plugin
 * runs on defaults.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULTS = {
  /**
   * SessionStart sources that trigger a full injection of the rules.
   *
   * Only 'compact' by default. On startup, resume, clear and fork Claude Code
   * loads CLAUDE.md itself, and injecting it again just spends context window
   * on a second copy. Compaction is the case where the original load may not
   * survive, so there is nothing left to re-read from.
   */
  injectOn: ['compact'],
  /** Character budget for the injection. Above 10000 Claude Code files it out. */
  maxChars: 9000,
  /** Do not repeat the PostToolUse nudge more often than this. */
  nudgeCooldownSec: 45,
  /**
   * Nudge on every new file regardless of the cooldown. Off by default:
   * editing twenty files in a row would otherwise produce twenty nudges.
   */
  nudgeOnNewFile: false,
  /** Stop behaviour: feedback | block | off. */
  stopMode: 'feedback',
  /**
   * Demand an explicit rule-by-rule compliance list in the visible answer:
   *   analysis — whenever the answer concludes, analyses or recommends, and
   *              again before finishing a turn that changed state
   *   changes  — only before finishing a turn that changed state
   *   off      — never asked for
   * "Verify against the rules" alone is easy to answer with silence; naming
   * each rule and its verdict is not. Status updates and one-line factual
   * replies are exempt — a compliance list under "the monitor expired" is
   * noise, and noise is what teaches the model to skip the list entirely.
   * `always` is accepted as an alias for `analysis`.
   */
  complianceReport: 'analysis',
  /** One-line reminder on every user prompt. */
  promptReminder: true,
  /** Skip the nudge after clearly read-only Bash commands (ls, git status, …). */
  skipReadOnlyBash: true,
  /** Include `.claude/rules/*.md` files without paths frontmatter. */
  includeRules: true,
  /** Include CLAUDE.local.md. */
  includeLocal: true,
  /** Include the machine-wide managed-policy CLAUDE.md. */
  includeManaged: true,
  /** How deep `@` imports are expanded (Claude Code allows 4 hops). */
  importDepth: 4,
  /** Overrides for the text that reaches the model. */
  messages: {},
};

const BOOL_KEYS = new Set([
  'nudgeOnNewFile',
  'promptReminder',
  'skipReadOnlyBash',
  'includeRules',
  'includeLocal',
  'includeManaged',
]);
const NUM_KEYS = new Set(['maxChars', 'nudgeCooldownSec', 'importDepth']);
const LIST_KEYS = new Set(['injectOn']);

export function loadConfig(cwd) {
  let config = { ...DEFAULTS, messages: { ...DEFAULTS.messages } };
  for (const file of configFiles(cwd)) {
    config = merge(config, readJson(file));
  }
  return normalize(merge(config, fromEnv()));
}

function normalize(config) {
  // `always` was the 0.2.0 name for this level.
  if (config.complianceReport === 'always') config.complianceReport = 'analysis';
  return config;
}

function configFiles(cwd) {
  const files = [
    join(homedir(), '.claude', 'claude-md-guard.json'),
    join(homedir(), '.claude', 'claude-md-guard.local.json'),
  ];
  if (cwd) {
    files.push(join(cwd, '.claude', 'claude-md-guard.json'));
    files.push(join(cwd, '.claude', 'claude-md-guard.local.json'));
  }
  return files;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function fromEnv() {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (key === 'messages') continue;
    const envName = `CLAUDE_MD_GUARD_${camelToEnv(key)}`;
    const raw = process.env[envName];
    if (raw === undefined || raw === '') continue;
    if (BOOL_KEYS.has(key)) out[key] = parseBool(raw);
    else if (NUM_KEYS.has(key)) out[key] = Number(raw);
    else if (LIST_KEYS.has(key)) out[key] = raw.split(/[,\s]+/).filter(Boolean);
    else out[key] = raw;
  }
  return out;
}

function camelToEnv(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

function parseBool(raw) {
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

function merge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    if (!(key in DEFAULTS)) continue;
    if (key === 'messages') {
      if (typeof value === 'object') out.messages = { ...out.messages, ...value };
      continue;
    }
    if (NUM_KEYS.has(key) && !Number.isFinite(Number(value))) continue;
    if (LIST_KEYS.has(key)) {
      out[key] = Array.isArray(value)
        ? value.map(String)
        : String(value).split(/[,\s]+/).filter(Boolean);
      continue;
    }
    out[key] = NUM_KEYS.has(key) ? Number(value) : value;
  }
  return out;
}

/** A message with config.messages overrides applied. */
export function message(config, key, fallback) {
  const custom = config && config.messages ? config.messages[key] : undefined;
  return typeof custom === 'string' && custom.trim() ? custom : fallback;
}
