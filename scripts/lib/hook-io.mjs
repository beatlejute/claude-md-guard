/**
 * Input and output for Claude Code hook scripts.
 *
 * The hook contract: the event arrives as JSON on stdin, the reply goes out as
 * JSON on stdout. A failure inside a hook must never break the user's session,
 * so run() swallows every exception and exits 0 with empty stdout.
 */

import { writeSync } from 'node:fs';

const STDIN_TIMEOUT_MS = 5000;

/** Reads the event JSON from stdin. Returns {} on any failure or timeout. */
export async function readInput() {
  const raw = await readStdin();
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    // Do not keep the process alive for this timer alone.
    if (typeof timer.unref === 'function') timer.unref();

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

/**
 * Writes the hook's JSON reply. An empty payload produces no output at all.
 *
 * Written with writeSync rather than process.stdout.write: stdout is a pipe
 * here, and pipes are asynchronous on macOS, so the exit below could discard
 * a reply that had not been flushed yet. Short replies survived, a 9 KB rule
 * injection did not.
 */
export function emit(payload) {
  if (!payload) return;
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  let written = 0;
  while (written < data.length) {
    try {
      written += writeSync(1, data, written, data.length - written);
    } catch (err) {
      if (err.code === 'EAGAIN') continue; // non-blocking pipe, not yet drained
      throw err;
    }
  }
}

/**
 * The hookSpecificOutput.additionalContext reply — the general-purpose way to
 * put text into the model's context, wrapped in a system reminder.
 */
export function additionalContext(hookEventName, text) {
  if (!text) return null;
  return { hookSpecificOutput: { hookEventName, additionalContext: text } };
}

/** Runs the hook body, swallowing errors: the session matters more than the hook. */
export async function run(main) {
  try {
    const result = await main();
    emit(result);
  } catch (err) {
    if (process.env.CLAUDE_MD_GUARD_DEBUG) {
      process.stderr.write(`claude-md-guard: ${err && err.stack ? err.stack : err}\n`);
    }
  }
  process.exit(0);
}
