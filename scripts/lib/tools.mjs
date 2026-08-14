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
  const tokens = tokenize(segment);
  while (tokens.length > 0 && (WRAPPERS.has(tokens[0]) || tokens[0].includes('='))) {
    tokens.shift();
  }
  if (tokens.length === 0) return true;

  const binary = tokens[0].split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, '');
  if (binary === 'git') {
    const sub = tokens.slice(1).find((token) => !token.startsWith('-'));
    return sub ? READ_ONLY_GIT.has(sub) : true;
  }
  return READ_ONLY_COMMANDS.has(binary);
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
