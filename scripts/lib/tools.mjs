/**
 * Reading a tool call: what actually changed, and whether it is worth reacting
 * to at all.
 *
 * A nudge after `git status` or `ls` is pure noise: CLAUDE.md rules are about
 * what the agent does to the project, not about what it read.
 */

import { displayPath } from './claude-md.mjs';

/** Commands that change nothing, so no nudge is warranted. */
const READ_ONLY_COMMANDS = new Set([
  'awk', 'basename', 'bat', 'cat', 'cd', 'df', 'dirname', 'du', 'echo', 'env',
  'fd', 'file', 'find', 'grep', 'head', 'hostname', 'jq', 'less', 'ls', 'man',
  'nl', 'od', 'printenv', 'ps', 'pwd', 'rg', 'sort', 'stat', 'tail', 'tree',
  'type', 'uname', 'uniq', 'wc', 'whereis', 'which', 'who', 'whoami',
]);

/** git subcommands that only read state. */
const READ_ONLY_GIT = new Set([
  'blame', 'branch', 'config', 'describe', 'diff', 'log', 'ls-files',
  'ls-remote', 'remote', 'rev-parse', 'shortlog', 'show', 'status', 'tag',
]);

/**
 * PowerShell cmdlets and aliases that only read. Matched case-insensitively,
 * because PowerShell is. Deliberately absent: ForEach-Object and Invoke-*,
 * whose script blocks can do anything — a false nudge there is cheaper than a
 * missed change.
 */
const READ_ONLY_POWERSHELL = new Set([
  'compare-object', 'convertfrom-json', 'convertfrom-string', 'convertto-json',
  'get-alias', 'get-childitem', 'get-command', 'get-content', 'get-date',
  'get-help', 'get-history', 'get-item', 'get-itemproperty', 'get-location',
  'get-member', 'get-module', 'get-process', 'get-service', 'get-variable',
  'group-object', 'join-path', 'measure-object', 'out-host', 'out-string',
  'pop-location', 'push-location', 'resolve-path', 'select-object',
  'select-string', 'set-location', 'sort-object', 'split-path', 'test-path',
  'where-object', 'write-host', 'write-output',
  // aliases
  'cd', 'chdir', 'dir', 'gc', 'gci', 'gcm', 'gi', 'gl', 'gm', 'group', 'gv',
  'measure', 'popd', 'pushd', 'sls', 'sort', 'where', 'select', 'ft', 'fl',
  'ls', 'cat', 'echo', 'pwd', 'type',
]);

/** Formatting cmdlets: harmless anywhere in a pipeline. */
const FORMATTING_POWERSHELL = /^format-(table|list|wide|custom)$/i;

/** Wrappers to strip before the real command becomes visible. */
const WRAPPERS = new Set(['rtk', 'sudo', 'command', 'time', 'nice', 'nohup', 'proxy']);

/** Tools that change nothing, even if the matcher let them through. */
const READ_ONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task',
  'NotebookRead', 'ListMcpResources', 'ReadMcpResource', 'ToolSearch',
]);

/**
 * @returns {{mutating: boolean, target: string|null, action: string}}
 */
export function describeTool(toolName, toolInput, config) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};

  if (READ_ONLY_TOOLS.has(toolName)) {
    return { mutating: false, target: null, action: `used ${toolName}` };
  }

  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const command = String(input.command || '').trim();
    const readOnly = config.skipReadOnlyBash && isReadOnlyCommand(command);
    return {
      mutating: !readOnly && command.length > 0,
      target: command ? truncate(firstLine(command), 120) : null,
      action: `ran a shell command via ${toolName}`,
    };
  }

  const path =
    input.file_path || input.notebook_path || input.path || input.filePath || null;
  const target = path ? displayPath(String(path)) : null;

  switch (toolName) {
    case 'Write':
      return { mutating: true, target, action: 'wrote' };
    case 'Edit':
    case 'MultiEdit':
      return { mutating: true, target, action: 'edited' };
    case 'NotebookEdit':
      return { mutating: true, target, action: 'edited notebook' };
    default:
      return { mutating: Boolean(target), target, action: `changed via ${toolName}` };
  }
}

/** A command counts as read-only only if EVERY one of its segments does. */
export function isReadOnlyCommand(command) {
  if (!command) return true;
  if (/[>]{1,2}[^>]/.test(command)) return false; // any redirect into a file
  const segments = command.split(/\|\||&&|[|;\n]/);
  return segments.every((segment) => isReadOnlySegment(segment));
}

function isReadOnlySegment(segment) {
  const tokens = stripAssignment(tokenize(segment));
  while (tokens.length > 0 && (WRAPPERS.has(tokens[0]) || tokens[0].includes('='))) {
    tokens.shift();
  }
  if (tokens.length === 0) return true;

  const binary = tokens[0]
    .replace(/^[(&$]+/, '') // `(Get-Content ...)`, `& cmd`
    .split(/[\\/]/)
    .pop()
    .replace(/\.(exe|cmd|bat|ps1)$/i, '');
  const lower = binary.toLowerCase();

  // A bare `$c.Length` prints a value; `$file.Delete()` does not, hence the
  // parenthesis check.
  if (tokens[0].startsWith('$') && !tokens[0].includes('(')) return true;

  if (lower === 'git') {
    const sub = gitSubcommand(tokens);
    return sub ? READ_ONLY_GIT.has(sub) : true;
  }
  // Removing environment variables touches this process, not the project.
  if (lower === 'remove-item' || lower === 'ri' || lower === 'del') {
    return tokens.slice(1).some((token) => /^env:/i.test(token));
  }
  if (FORMATTING_POWERSHELL.test(binary)) return true;
  if (READ_ONLY_POWERSHELL.has(lower)) return true;
  return READ_ONLY_COMMANDS.has(binary);
}

/**
 * The subcommand in a git call, skipping the global options that take a value.
 * Without the skip, `git -C /repo log` reads as the subcommand "/repo".
 */
function gitSubcommand(tokens) {
  const takesValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (takesValue.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return token;
  }
  return null;
}

/**
 * Drops a leading PowerShell assignment: `$c = Get-Content x` is read-only
 * exactly when its right-hand side is. Without this every captured pipeline
 * counted as a change.
 */
function stripAssignment(tokens) {
  if (tokens.length >= 2 && /^\$[\w:.]+$/.test(tokens[0]) && tokens[1] === '=') {
    return tokens.slice(2);
  }
  if (tokens.length >= 1 && /^\$[\w:.]+=$/.test(tokens[0])) {
    return tokens.slice(1);
  }
  return tokens;
}

function tokenize(segment) {
  return segment
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/^["']|["']$/g, ''));
}

function firstLine(text) {
  const line = text.split('\n')[0].trim();
  return line || text.trim();
}

function truncate(text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
