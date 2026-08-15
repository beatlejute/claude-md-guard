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
  '[', 'awk', 'base64', 'basename', 'bat', 'cat', 'cd', 'column', 'comm',
  // `env` is deliberately absent: bare `env` prints, but `env VAR=1 npm run
  // build` runs. It is stripped as a prefix so the real command is judged.
  'cut', 'date', 'df', 'diff', 'dirname', 'du', 'echo', 'export', 'fd',
  'file', 'find', 'grep', 'head', 'hostname', 'id', 'jq', 'less', 'ls', 'man',
  'md5sum', 'nl', 'od', 'printenv', 'printf', 'ps', 'pwd', 'read', 'readlink',
  'realpath', 'rg', 'seq', 'set', 'sha256sum', 'sleep', 'sort', 'stat', 'tail',
  'tasklist', 'test', 'tr', 'tree', 'type', 'uname', 'uniq', 'unset', 'wc',
  'whereis', 'which', 'who', 'whoami', 'wmic', 'xxd',
]);

/** git subcommands that only read state. */
const READ_ONLY_GIT = new Set([
  'blame', 'branch', 'cat-file', 'config', 'count-objects', 'describe', 'diff',
  'fetch', 'for-each-ref', 'log', 'ls-files', 'ls-remote', 'merge-base',
  'name-rev', 'remote', 'rev-list', 'rev-parse', 'shortlog', 'show',
  'status', 'symbolic-ref', 'tag',
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

/** Shell keywords that open a block: the header itself runs nothing. */
const BLOCK_HEADERS = new Set(['for', 'while', 'until', 'if', 'elif', 'case', 'select']);

/** Keywords that precede a real command in the same segment. */
const BLOCK_PREFIXES = new Set(['do', 'then', 'else', '{', '(', '!']);

/** Keywords that close a block, or are no-ops on their own. */
const BLOCK_ENDS = new Set(['done', 'fi', 'esac', '}', ')', ';;', 'true', 'false', ':']);

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
  return splitSegments(stripHeredocs(command)).every(
    (segment) => !writesToFile(segment) && isReadOnlySegment(segment),
  );
}

/**
 * Removes here-document bodies, keeping the line that opens them.
 *
 * The body belongs to another interpreter — `python - <<'PY' … PY` carries
 * Python, not shell — and parsing it as shell turned every `import json` and
 * `except: continue` into an unrecognized command.
 */
function stripHeredocs(command) {
  if (!command.includes('<<')) return command;
  const kept = [];
  let marker = null;
  for (const line of command.split('\n')) {
    if (marker !== null) {
      if (line.trim() === marker) marker = null;
      continue;
    }
    kept.push(line);
    const opener = line.match(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1/);
    if (opener) marker = opener[2];
  }
  return kept.join('\n');
}

/**
 * Splits on `|`, `||`, `&&`, `;` and newlines — but only outside quotes.
 * A naive split tore `grep -E "Error|Timeout"` into a segment named
 * "Timeout", so every log search read as a change to the project.
 */
function splitSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote) {
      current += char;
      if (char === quote && command[i - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '|' || char === ';' || char === '\n') {
      segments.push(current);
      current = '';
      if (char === '|' && command[i + 1] === '|') i += 1;
      continue;
    }
    if (char === '&' && command[i + 1] === '&') {
      segments.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments.filter((segment) => segment.trim());
}

/**
 * A redirect that lands in a real file. `2>&1` duplicates a descriptor and
 * `2>/dev/null` throws output away — neither touches the project, and both
 * appear in nearly every diagnostic command.
 */
function writesToFile(segment) {
  let quote = null;
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i];
    if (quote) {
      if (char === quote && segment[i - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char !== '>') continue;

    let j = i + 1;
    if (segment[j] === '>') j += 1;
    // `>&1` duplicates a descriptor; `>&file` names a file.
    if (segment[j] === '&') {
      if (/^\d/.test(segment.slice(j + 1))) continue;
      return true;
    }
    while (segment[j] === ' ') j += 1;
    const target = segment.slice(j).split(/\s/)[0].replace(/^["']|["']$/g, '');
    if (!/^(\/dev\/null|nul|NUL)$/.test(target)) return true;
    i = j;
  }
  return false;
}

function isReadOnlySegment(segment) {
  const tokens = stripPrefixes(stripAssignment(tokenize(segment)));
  if (tokens.length === 0) return true;
  // `for f in *.log` and `done` execute nothing; the body arrives as its own
  // segment after `do`, and is judged there.
  if (BLOCK_HEADERS.has(tokens[0]) || BLOCK_ENDS.has(tokens[0])) return true;

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
    if (!sub) return true;
    // `git worktree list` reads; `add` and `remove` do not.
    if (sub === 'worktree') return tokens[tokens.indexOf(sub) + 1] === 'list';
    return READ_ONLY_GIT.has(sub);
  }
  // Removing environment variables touches this process, not the project.
  if (lower === 'remove-item' || lower === 'ri' || lower === 'del') {
    return tokens.slice(1).some((token) => /^env:/i.test(token));
  }
  // `sed -n '1p'` prints; `sed -i` rewrites the file in place.
  if (lower === 'sed') return !tokens.slice(1).some((token) => /^-\w*i/.test(token));
  // `unzip -l` lists, `unzip -p` pipes; bare `unzip` extracts to disk.
  if (lower === 'unzip') return tokens.slice(1).some((token) => /^-\w*[ltpvz]/.test(token));

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
 * Strips everything in front of the command that actually runs: wrappers,
 * block keywords, inline `VAR=value` assignments, and an `env` invocation
 * with its own options, so `env -u HTTP_PROXY npm run build` is judged as
 * `npm run build`.
 */
function stripPrefixes(tokens) {
  let inEnv = false;
  while (tokens.length > 0) {
    const token = tokens[0];
    if (token === 'env') {
      tokens.shift();
      inEnv = true;
      continue;
    }
    if (inEnv && token === '-u' && tokens.length > 1) {
      tokens.splice(0, 2);
      continue;
    }
    if (inEnv && token.startsWith('-')) {
      tokens.shift();
      continue;
    }
    if (WRAPPERS.has(token) || BLOCK_PREFIXES.has(token) || token.includes('=')) {
      tokens.shift();
      continue;
    }
    break;
  }
  return tokens;
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
