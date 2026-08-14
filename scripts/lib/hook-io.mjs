/**
 * Input and output for Claude Code hook scripts.
 *
 * The hook contract: the event arrives as JSON on stdin, the reply goes out as
 * JSON on stdout. A failure inside a hook must never break the user's session,
 * so run() swallows every exception and exits 0 with empty stdout.
 */

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

/** Writes the hook's JSON reply. An empty payload produces no output at all. */
export function emit(payload) {
  if (!payload) return;
  process.stdout.write(JSON.stringify(payload));
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
