/**
 * Collecting the CLAUDE.md rules in force, in the order Claude Code itself
 * loads them (see docs/en/memory):
 *
 *   managed policy → ~/.claude/CLAUDE.md → ~/.claude/rules/*.md →
 *   project CLAUDE.md files from the top of the tree down to the working
 *   directory (CLAUDE.local.md right after CLAUDE.md at each level) →
 *   .claude/CLAUDE.md → .claude/rules/*.md
 *
 * Two things Claude Code does at load time are reproduced here as well:
 * expanding `@` imports (up to 4 hops, skipping code) and stripping block HTML
 * comments.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

const MAX_TREE_DEPTH = 20;
const DEFAULT_BUDGET = 9000;

/** Path to the machine-wide (managed policy) CLAUDE.md for this OS. */
export function managedPolicyPath() {
  switch (platform()) {
    case 'win32':
      return 'C:\\Program Files\\ClaudeCode\\CLAUDE.md';
    case 'darwin':
      return '/Library/Application Support/ClaudeCode/CLAUDE.md';
    default:
      return '/etc/claude-code/CLAUDE.md';
  }
}

/**
 * Finds the rule files that apply to this working directory.
 * `priority` is how specific a file is: the higher it is, the more worth
 * keeping when the character budget runs short. Array order is load order.
 */
export function discoverMemoryFiles(cwd, config) {
  const files = [];
  const seen = new Set();
  const add = (path, scope, priority) => {
    if (!path) return;
    const key = resolve(path).toLowerCase();
    if (seen.has(key)) return;
    if (!isFile(path)) return;
    seen.add(key);
    files.push({ path, scope, priority });
  };

  if (config.includeManaged) add(managedPolicyPath(), 'managed', 0);

  const userDir = join(homedir(), '.claude');
  add(join(userDir, 'CLAUDE.md'), 'user', 10);
  if (config.includeRules) {
    for (const rule of rulesIn(join(userDir, 'rules'))) add(rule, 'user-rule', 11);
  }

  // Walking up the tree Claude Code looks only for CLAUDE.md and
  // CLAUDE.local.md; .claude/CLAUDE.md and .claude/rules/ are project level.
  const chain = ancestorChain(cwd);
  for (const [index, dir] of chain.entries()) {
    const base = 20 + index * 10;
    const isProjectRoot = index === chain.length - 1;
    add(join(dir, 'CLAUDE.md'), 'project', base);
    if (isProjectRoot) {
      add(join(dir, '.claude', 'CLAUDE.md'), 'project', base + 1);
      if (config.includeRules) {
        for (const rule of rulesIn(join(dir, '.claude', 'rules'))) {
          add(rule, 'project-rule', base + 2);
        }
      }
    }
    if (config.includeLocal) add(join(dir, 'CLAUDE.local.md'), 'local', base + 3);
  }

  return files;
}

/** Directories from the top of the tree down to cwd — Claude Code's order. */
function ancestorChain(cwd) {
  if (!cwd) return [];
  const chain = [];
  let dir = resolve(cwd);
  for (let i = 0; i < MAX_TREE_DEPTH; i += 1) {
    chain.push(dir);
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return chain.reverse();
}

/** Rules from .claude/rules: only those loaded at launch, i.e. without paths. */
function rulesIn(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => join(dir, entry.name))
    .filter((path) => !isPathScopedRule(path))
    .sort();
}

/** A rule with `paths:` in its frontmatter loads on demand, not at launch. */
function isPathScopedRule(path) {
  const text = readText(path);
  if (!text.startsWith('---')) return false;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return false;
  return /^\s*paths\s*:/m.test(text.slice(3, end));
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Prepares one rule file: expands `@` imports and drops block HTML comments,
 * the same two transformations Claude Code applies.
 */
export function prepareFile(path, config) {
  const raw = readText(path);
  const expanded = expandImports(raw, path, config.importDepth, new Set([resolve(path)]));
  return stripHtmlComments(expanded).trim();
}

/**
 * Expands `@path` outside code. Relative paths resolve against the importing
 * file, `~/` against the home directory. A path that does not exist is left as
 * plain text.
 */
export function expandImports(text, baseFile, depthLeft, seen) {
  if (!text || depthLeft <= 0) return text;
  return mapProse(text, (segment) =>
    segment.replace(/(^|[\s(<])@([^\s)>,;]+)/g, (match, prefix, rawPath) => {
      const target = resolveImport(rawPath, baseFile);
      if (!target || seen.has(target) || !isFile(target)) return match;
      seen.add(target);
      const nested = expandImports(readText(target), target, depthLeft - 1, seen);
      return `${prefix}\n${nested.trim()}\n`;
    }),
  );
}

function resolveImport(rawPath, baseFile) {
  let candidate = rawPath.replace(/[.,;:]+$/, '');
  if (!candidate) return null;
  if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    candidate = join(homedir(), candidate.slice(2));
  }
  if (isAbsolute(candidate)) return resolve(candidate);
  if (!baseFile) return null;
  return resolve(dirname(baseFile), candidate);
}

/** Removes HTML comments outside code blocks. */
export function stripHtmlComments(text) {
  return mapProse(text, (segment) => segment.replace(/<!--[\s\S]*?-->/g, ''))
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Applies a transformation to prose only: fenced blocks and inline code
 * (`...`) are left untouched, matching how Claude Code parses imports.
 */
function mapProse(text, transform) {
  const lines = text.split('\n');
  let fence = null;
  const out = lines.map((line) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = null;
      }
      return line;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      return line;
    }
    return mapOutsideInlineCode(line, transform);
  });
  return out.join('\n');
}

function mapOutsideInlineCode(line, transform) {
  const parts = line.split(/(`+[^`]*`+)/g);
  return parts
    .map((part, index) => (index % 2 === 1 ? part : transform(part)))
    .join('');
}

/**
 * Assembles the rules into one text within the character budget.
 * When the budget runs short the least specific files are dropped first
 * (managed → user → upper directories); the ones closest to cwd survive.
 */
export function buildBundle(cwd, config) {
  const discovered = discoverMemoryFiles(cwd, config);
  const prepared = discovered
    .map((file) => ({ ...file, body: prepareFile(file.path, config) }))
    .filter((file) => file.body.length > 0);

  const budget = Math.max(500, Number(config.maxChars) || DEFAULT_BUDGET);
  const keep = new Set();
  let used = 0;
  for (const file of [...prepared].sort((a, b) => b.priority - a.priority)) {
    const cost = file.body.length + file.path.length + 40;
    if (used + cost > budget && keep.size > 0) continue;
    keep.add(file.path);
    used += cost;
  }

  const included = prepared.filter((file) => keep.has(file.path));
  const skipped = prepared.filter((file) => !keep.has(file.path));
  const text = included
    .map((file) => `### ${displayPath(file.path)}\n${file.body}`)
    .join('\n\n');

  return { text, included, skipped, chars: text.length };
}

/** Home directory collapses to ~ — shorter, and it hides the user name. */
export function displayPath(path) {
  const home = homedir();
  if (home && path.toLowerCase().startsWith(home.toLowerCase())) {
    return `~${path.slice(home.length)}`.split(sep).join('/');
  }
  return path.split(sep).join('/');
}
