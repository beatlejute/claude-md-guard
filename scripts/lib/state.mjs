/**
 * The record of state-changing actions in the current turn, keyed by session_id.
 *
 * PostToolUse appends lines, Stop reads them and deletes the file. The format
 * is append-only JSONL: several hooks from one batch write concurrently, and
 * appending a short line is atomic where read-modify-write is not.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STALE_MS = 24 * 60 * 60 * 1000;

export function stateDir() {
  const base = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'claude-md-guard');
  return join(base, 'turns');
}

export function turnFile(sessionId) {
  return join(stateDir(), `${safeName(sessionId)}.jsonl`);
}

function safeName(sessionId) {
  const raw = String(sessionId || 'unknown');
  if (/^[A-Za-z0-9._-]{1,64}$/.test(raw)) return raw;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/** Appends a change event. Returns false if the write failed. */
export function recordChange(sessionId, entry) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    appendFileSync(turnFile(sessionId), `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Reads this turn's events. Malformed lines are skipped silently. */
export function readTurn(sessionId) {
  let raw;
  try {
    raw = readFileSync(turnFile(sessionId), 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* skip a partially written line */
    }
  }
  return events;
}

export function clearTurn(sessionId) {
  try {
    rmSync(turnFile(sessionId), { force: true });
  } catch {
    /* nothing to clean up */
  }
}

/** Drops records for sessions whose Stop never arrived. */
export function pruneStale(maxAgeMs = STALE_MS) {
  let entries;
  try {
    entries = readdirSync(stateDir());
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of entries) {
    const path = join(stateDir(), name);
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
      /* the file is already gone */
    }
  }
}
